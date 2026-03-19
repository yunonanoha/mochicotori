const sharp = require('sharp');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use((req, res, next) => {
  // hostnameだけでなく、独自ドメインじゃない場合は全部飛ばすという考え方
  if (req.hostname.includes('onrender.com')) {
    return res.redirect(301, `https://mochicotori.com${req.originalUrl}`);
  }
  next();
});

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = socketIo(server);

// ✅ サーバー側：クライアントと完全に同期させたモード設定
const MODE_SETTINGS = {
  mochicotori: {
    label: 'モチコトリ',
    defaults: { 
      finishType: 'finalround',
      turnBased: true, 
      shiritori: true, 
      vote: true, 
      pass: true, 
      exchange: true, 
      like: true, 
      deco: false, 
      star5: false, 
      score100: false 
    }
  },
  story: {
    label: 'ストーリー',
    defaults: { 
      finishType: 'allOut', 
      turnBased: false, 
      shiritori: false, 
      vote: false, 
      pass: false, 
      exchange: false, 
      like: true, 
      deco: false, 
      star5: false, 
      score100: true 
    }
  },
  word: {
    label: 'ワード',
    defaults: { 
      finishType: 'allOut', 
      turnBased: false, 
      shiritori: false, 
      vote: false, 
      pass: false, 
      exchange: false, 
      like: false, 
      deco: true, 
      star5: false, 
      score100: true 
    }
  },
  chain: {
    label: 'チェーン',
    defaults: { 
      finishType: 'instant', 
      turnBased: false, 
      shiritori: true, 
      vote: true, 
      pass: false, 
      exchange: true, 
      like: false, 
      deco: false, 
      star5: false, 
      score100: true 
    }
  }
};


// 📁 アップロード設定
const upload = multer({ dest: 'uploads/' });

// 🎨 プレイヤーカラー（重複なし用）
const PLAYER_COLORS = [
    "#D32F2F", // 1: 鮮やかなレッド（視認性最強）
    "#1976D2", // 2: 信頼感のあるブルー
    "#2E7D32", // 3: 濃いグリーン（フォレスト）
    "#7B1FA2", // 4: 高貴なパープル
    "#E65100", // 5: 鮮明なオレンジ（アンバー）
    "#ee79c7"  // 6: ピンク
//        "#4a5568", // ダークスレートブルー
//        "#2d3748", // チャコールグレーに近いネイビー
//        "#744210", // 深みのあるウッドブラウン
//        "#285e61", // 深い青緑（ティール）
//        "#2c5282", // シックなロイヤルブルー
//        "#5a67d8", // 少し落ち着いたインディゴ
//        "#702459", // 深いプラム
//        "#9b2c2c", // 渋いレッド
//        "#276749", // フォレストグリーン
//        "#7b341e", // テラコッタ・レンガ色
//        "#44337a", // 深いパープル
//        "#234e52", // ダークシアン
//        "#e95388", // オペラ
//        "#1a365d"  // ディープネイビー
//  '#ff0000', '#0400ff', '#17bf1a', '#9b59b6',
//  '#e67e22', '#83274e', '#876640', '#190e5c',
//  '#606626', '#e95388', '#21acde', '#2f7d6b'
];

// ゲーム開始ロジック
function startGameLogic(roomId, data, socket) {
    let targetRoomId = roomId || socket.roomId || (data && data.roomId);
    const room = rooms[targetRoomId];
    
    const HAND_SIZE = 5; 
    const activePlayers = room.players.filter(p => !p.isObserver);
    
    if (!room) return;
    
    // --- 🚩 1. 設定の反映（辞書による強制ガード） ---
    if (data && data.mode) room.mode = data.mode;

    // 辞書から現在のモードの正解を取得
    const modeSetting = MODE_SETTINGS[room.mode] || MODE_SETTINGS['story'];

// 🚩 安全なオプション展開
    const incomingOptions = data.options || {};
    
    room.options = { 
        ...modeSetting.defaults, 
        ...incomingOptions 
    };

    // 🚩 【超重要】もし options.options のように二重になっていたら救済する
    if (incomingOptions.options) {
        room.options = { ...room.options, ...incomingOptions.options };
    }

    // デバッグログ：ここが false だと絶対に出ません
    console.log(`🛡️ 最終確定オプション (${room.mode}):`, room.options);


    // --- 🚩 2. 状態のリセット ---
room.phase = 'playing';
room.finalround = false;
room.field = [];
room.turnIndex = 0;
room.gameRatings = {}; // 🚩 満足度投票もリセット
room.lastResultData = null; // 🚩 古いリザルトデータを破棄

// 🚩 追加：クライアント側の「表示済みフラグ」をリセットさせるためのイベント
// これを送ることで、クライアント側で window.hasClosedResult = false にさせる
io.to(targetRoomId).emit('resetResultFlags');
    
// --- 🚩 3. デッキ生成の準備（これが必要！） ---
let inputImages = [];
let inputText = "";

// モードに応じた入力の取捨選択
if (room.mode === 'mochicotori') {
    // 🎨 モチコトリ：画像のみ採用。テキストは強制的に空にする。
    inputImages = (data && data.images && data.images.length > 0) ? data.images : (room.masterImages || []);
    inputText = ""; 
} else if (room.mode === 'story') {
    // 📖 ストーリー：画像もテキストも両方採用
    inputImages = (data && data.images && data.images.length > 0) ? data.images : (room.masterImages || []);
    
    if (data && data.textDeck && data.textDeck.trim() !== "") {
        inputText = data.textDeck;
    } else if (room.masterTextDeck && room.masterTextDeck.length > 0) {
        inputText = room.masterTextDeck.map(t => t.replace(/^text:/, '')).join('\n');
    }
} else {
    // 🧱 ワード・チェーン：generateDeck 側で自動生成されるため空でOK
    inputImages = [];
    inputText = "";
}

// C. 共通関数でデッキ生成
const nextDeckData = generateDeck(room.mode, inputImages, inputText);

// 🚩 ここで最終チェック
if (nextDeckData.deck.length === 0) {
    // ワードモードやチェーンモードは自動生成なので0にはならないはずだが、
    // ストーリー等で「新旧どちらも空」ならここでエラーを返す
    if (socket && socket.id){
    return io.to(socket.id).emit('errorMessage', "デッキが空です。新しいデッキをセットしてください。");
        }
}

// 🚩 部屋のデータを更新（これで次戦に引き継がれる）
room.masterImages = nextDeckData.masterImages;
room.masterTextDeck = nextDeckData.masterTextDeck;
room.deck = nextDeckData.deck;

    // 🚩 ターン制じゃないモードの強制ルール適用
    if (!room.options.turnBased) {
        room.options.pass = false; // パスはオフ（ロック）
        // 手札交換は exchangeCards 側のロジックで制御
    }

    // モード名の日本語変換
const modeNames = { 
    mochicotori: "モチコトリ", 
    story: "ストーリー", 
    word: "ワード", 
    chain: "チェーン" 
};
const modeDisp = modeNames[room.mode] || room.mode;

// 🚩 指定のアナウンス形式に修正
const starterName = data.name || "管理者";
const starterColor = data.color || "#888";

io.to(targetRoomId).emit('message', { 
    text: `🚩 ${starterName} さんが ${modeDisp}モードでゲームを開始しました！`, 
    color: starterColor 
});

    
    // しりとり文字決定
    if (room.options.shiritori) {
        const chars = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ";
        room.prevLast = chars[Math.floor(Math.random() * chars.length)];
        io.to(targetRoomId).emit('message', { text: `📢 最初の文字は「${room.prevLast}」です！`, color: "#ff9800" });
    } else {
        room.prevLast = null;
    }

// --- プレイヤー順の確定と起家の設定 ---
//const activePlayers = room.players.filter(p => !p.isObserver);
const observers = room.players.filter(p => p.isObserver);

if (activePlayers.length > 0) {
    // 1. 参加者だけをシャッフル
    for (let i = activePlayers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [activePlayers[i], activePlayers[j]] = [activePlayers[j], activePlayers[i]];
    }

    // 2. 👑 起家の決定（シャッフルで「たまたま先頭になった人」を今回の親にする）
    room.firstPlayerId = activePlayers[0].id;
    room.turnIndex = 0; 

    // 3. 【重要】部屋のプレイヤーリストを「シャッフル済み参加者 + 観戦者」で作り直す
    // これをやらないと、turnIndex=0 が誰を指すか不安定になります
    room.players = [...activePlayers, ...observers];
    
    console.log(`👑 起家確定: ${activePlayers[0].name} (ID: ${room.firstPlayerId})`);
}
    
// --- 🚩 5. 配る処理 ---
console.log(`🎴 カード配布開始: 山札残 ${room.deck.length}枚 / 参加者 ${room.players.length}名`);

// 1. 全員の手札と「完了フラグ」をリセット
room.players.forEach(p => {
    p.hand = [];
    // 🚩 2戦目以降のために完了フラグをリセット！
    p.hasFinishedLikeCheck = false;
    p.hasFinishedDecoCheck = false;
});

// 2. サーバー側の進捗管理用 Set も空にする（念のため）
room.finishedLikeCheckers = new Set();
room.finishedDecoCheckers = new Set();

// 2. 1枚ずつ配る
for (let i = 0; i < HAND_SIZE; i++) {
    activePlayers.forEach(p => {
        if (room.deck && room.deck.length > 0) {
            p.hand.push(room.deck.shift());
        }
    });
}

// 3. 各プレイヤーへ「自分の手札」を個別送信
room.players.forEach(p => {
    io.to(p.id).emit('dealCards', p.hand);
});

// --- 🚩 6. ターンの初期化と最終同期 ---

// 4. 最初のターンプレイヤーを固定 (最初のプレイヤー)
room.turnIndex = 0; 

// 5. 部屋全体の「完全な最新状態」を作成
// targetRoomId を一貫して使用する
const finalState = getRoomState(targetRoomId);

if (finalState) {
    console.log(`📡 最新状態を送信: deckCount=${finalState.deckCount}, turnPlayer=${finalState.currentPlayerId}`);
    
    // 🚩 【重要】roomState はこれ一回だけでOK！ 
    // これの中に phase, deckCount, players, options がすべて入っています
console.log("👑 送信直前の起家ID:", finalState.firstPlayerId); 
io.to(targetRoomId).emit('roomState', finalState);

    // 🚩 補助的な通知（必要なら）
    io.to(targetRoomId).emit('phaseUpdated', room.phase);
    io.to(targetRoomId).emit('updateField', room.field);
}
}
    
function getRoomState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    const playersOnly = room.players.filter(p => !p.isObserver);
    const currentPlayer = playersOnly.length > 0 ? playersOnly[room.turnIndex] : null;
    
    return {
        mode: room.mode || 'story',
        phase: room.phase || 'playing', 
        options: {
            mode: room.mode,
            shiritori: !!room.options.shiritori,
            turnBased: !!room.options.turnBased,
            finishType: room.options.finishType,
            vote: !!room.options.vote,
            star5: !!room.options.star5,
            score100: !!room.options.score100,
            like: !!room.options.like,
            deco: !!room.options.deco,
            exchange: !!room.options.exchange,
            pass: !!room.options.pass
        },
        firstPlayerId: room.firstPlayerId, // 🚩 これを追加！
        textDeck: room.textDeck || [],
        finalround: !!room.finalround, 
        field: room.field || [],currentRating: room.currentRating || null,
        deckCount: room.deck ? room.deck.length : 0,
        currentVote: room.currentVote || null,
        turnIndex: room.turnIndex, 
        currentPlayerId: currentPlayer ? currentPlayer.id : null,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            isObserver: !!p.isObserver, // 確実に真偽値を送る
            // 参加者は枚数(数字)、観戦者は null を送ることでフロント側で出し分ける
            hasFinishedLikeCheck: !!p.hasFinishedLikeCheck, 
            hasFinishedDecoCheck: !!p.hasFinishedDecoCheck,
            cards: p.isObserver ? null : (p.hand ? p.hand.length : 0) 
        })),
        lastResultData: room.lastResultData || null
    };
}
// 部屋を完全に初期状態に掃除する関数
function resetRoomToDefault(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    console.log(`🧹 部屋 ${roomId} を完全リセットしました。`);

    // --- 状態の完全初期化 ---
    room.phase = 'playing';
    
    // 🚩 修正：現在のモードを維持するか、デフォルトの 'story' を設定
    const currentMode = room.mode || 'story';
    room.mode = currentMode;

    // 🚩 重要：直書きをやめて、サーバー上の MODE_SETTINGS からデフォルト設定をコピーする
    // Object.assign を使うことで、参照ではなく値をコピーします
    const defaultOptions = MODE_SETTINGS[currentMode] 
        ? MODE_SETTINGS[currentMode].defaults 
        : MODE_SETTINGS['story'].defaults;
        
    room.options = Object.assign({}, defaultOptions);
    
    room.field = [];
    room.deck = [];
    room.textDeck = [];
    room.images = [];
    room.prevLast = null;
    room.turnIndex = 0;
    room.finalround = false;
    room.currentVote = null;
    room.currentRating = null;
    room.gameRatings = {};
    room.finishedDecoCheckers = new Set();
    room.finishedLikeCheckers = new Set();
    room.finalRatings = {};

    // 🚩 同期データを送信
    // getRoomState(roomId) を使って送るのが最も安全で確実です
    io.to(roomId).emit('roomState', getRoomState(roomId));
    
    // 場の掃除も通知
    io.to(roomId).emit('updateField', []);
    io.to(roomId).emit('roomState', getRoomState(roomId));
}

function getRandomColor(used = []) {
  const available = PLAYER_COLORS.filter(c => !used.includes(c));
  return available.length
    ? available[Math.floor(Math.random() * available.length)]
    : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function rejectPlayedCard(room, player, cardPath) {
  // 🔴 room.field.filter の行を削除（これで場の残像が消えなくなります）

  // 1. デッキから「今出したカード以外」の候補を探す
  const candidates = room.deck.filter(c => c !== cardPath);

  let drawn;
  if (candidates.length > 0) {
    drawn = candidates[Math.floor(Math.random() * candidates.length)];
    room.deck.splice(room.deck.indexOf(drawn), 1);
    
    // 2. 元のカードをデッキに戻す
    room.deck.push(cardPath);
  } else {
    drawn = cardPath;
  }

  room.deck.sort(() => Math.random() - 0.5);
  player.hand.push(drawn);
}

// 1. まず、エラーで呼ばれていた関数を「独立して」定義する
function startDecoCheckPhase(room, roomId) {
    if (!room) return;
    room.phase = 'decoCheck';
    console.log(`🎨 Room ${roomId}: 装飾フェーズ開始`);
    
    io.to(roomId).emit('phaseUpdate', { 
        phase: 'decoCheck', 
        message: '装飾タイム！文字の見た目を整えましょう。' 
    });
    // 全員に状態を同期（これでフロントの null枚 バグ等も上書きされる）
    io.to(roomId).emit('roomState', getRoomState(roomId));
}

/**
 * 起家の状態を健全に保つ共通関数
 * @param {Object} room 
 * @returns {string|null} 更新後の起家ID
 */
function validateAndSyncFirstPlayer(room) {
    const activePlayers = room.players.filter(p => !p.isObserver);
    
    // 1. 参加者がいなくなった場合
    if (activePlayers.length === 0) {
        room.firstPlayerId = null;
        return null;
    }

    // 2. 現在の起家が有効か（まだ参加者にいるか）チェック
    const isFirstPlayerStillActive = activePlayers.some(p => p.id === room.firstPlayerId);

    // 3. 起家がいなくなっていたら、現在の先頭プレイヤーに引き継ぐ
    if (!room.firstPlayerId || !isFirstPlayerStillActive) {
        room.firstPlayerId = activePlayers[0].id;
        console.log(`👑 起家を更新しました: ${room.firstPlayerId}`);
    }

    return room.firstPlayerId;
}

// ターンの渡し
function nextTurn(room, roomId) {
    if (!room) return;
    const playersOnly = room.players.filter(p => !p.isObserver);
    if (playersOnly.length === 0) return;

    // --- A. 終了フェーズへの移行関数 ---
    const proceedToNextPhase = () => {
        console.log("🏁 ゲーム終了条件を満たしました。リザルトへ移行します");
        room.finalround = false; 
        if (room.options.deco) return startDecoCheckPhase(room, roomId);
        if (typeof startLikeCheckPhase === 'function') return startLikeCheckPhase(room, roomId);
        room.phase = 'likeCheck';
        io.to(roomId).emit('roomState', getRoomState(roomId));
    };

    // --- B. パターン判定用のデータ準備 ---
    const allOut = playersOnly.every(p => !p.hand || p.hand.length === 0);
    const someoneOut = playersOnly.find(p => p.hand && p.hand.length === 0);

    // --- C. ゲーム終了分岐ロジック ---

    // 1. 【全員完走 (allOut)】
    if (room.options.finishType === 'allOut') {
        if (allOut) return proceedToNextPhase();
        // 全員完走以外は、誰か上がっていても続行
    }

    // 2. 【1人完走 (instant)】
    else if (room.options.finishType === 'instant') {
        if (someoneOut) return proceedToNextPhase();
    }

// 3. 【ファイナルラウンド (finalround)】
    else if (room.options.finishType === 'finalround') {
        if (someoneOut && !room.finalround) {
            room.finalround = true;
            io.to(roomId).emit('message', { text: `📢 ${someoneOut.name}さんが上がり！この周で終了です。`, color: "#ff5722" });

            // 🚩 【追加】もし「今上がった人」が「この周の最後の人」なら、
            // 次の人に回さず、今すぐ終わらせる！
            if (room.turnIndex === playersOnly.length - 1) {
                return proceedToNextPhase();
            }
        }
    }

// --- D. ターンを進める処理 ---
if (room.options.turnBased) {
    // 次のプレイヤーを計算
    room.turnIndex = (room.turnIndex + 1) % playersOnly.length;
    const nextP = playersOnly[room.turnIndex];

    // 🚩 修正：インデックス0ではなく「次の人が起家（firstPlayerId）かどうか」で判定
    if (room.finalround && nextP && nextP.id === room.firstPlayerId) {
        return proceedToNextPhase();
    }
    
    // 🚩 安全策：もし起家が行方不明（null）の場合などはインデックス0で予備判定
    if (room.finalround && !room.firstPlayerId && room.turnIndex === 0) {
        return proceedToNextPhase();
    }
}

    // --- E. 同期送信 ---
    const nextP = playersOnly[room.turnIndex];
    io.to(roomId).emit('turnUpdate', {
        turnIndex: room.options.turnBased ? room.turnIndex : -1,
        currentPlayerId: nextP ? nextP.id : null,
        currentPlayerName: nextP ? nextP.name : "全員"
    });
    io.to(roomId).emit('roomState', getRoomState(roomId));
}
// ゲーム終了時のランキング生成（フロントエンドで表示するためにemitする用）
function getLeaderboard(room) {
    const playerStats = room.players.map(p => {
        const history = p.scoreHistory || [];
        const avg = history.length > 0 
            ? (history.reduce((a, b) => a + b, 0) / history.length).toFixed(1)
            : "0.0";
        return { name: p.name, avg: parseFloat(avg), color: p.color };
    });

    // 平均の高い順にソート
    playerStats.sort((a, b) => b.avg - a.avg);

    const allScores = room.players.flatMap(p => p.scoreHistory || []);
    const globalAvg = allScores.length > 0
        ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
        : "0.0";

    return { globalAvg, rankings: playerStats };
}

// 🚩 投票完了チェック
function checkVoteComplete(room, roomId) {
    if (!room.currentVote) return;

    // 🚩 観戦者を除いた「実際のプレイヤー」かつ「提出者以外」を抽出
    const actualPlayers = room.players.filter(p => !p.isObserver);
    const currentVoters = actualPlayers.filter(p => p.id !== room.currentVote.submitterId);
    
    const totalNeeded = currentVoters.length;
    const votedCount = Object.keys(room.currentVote.votes).length;

    if (votedCount >= totalNeeded) {
        completeVote(room, roomId);
    } else {
        io.to(roomId).emit('voteUpdate', { votedCount, totalVoters: totalNeeded });
    }
}

function completeVote(room, roomId) {
  if (!room.currentVote) return;

  const voteData = { ...room.currentVote };
  const { card, text, submitterId, votes, voters } = voteData;
  room.currentVote = null; 

  const votesArray = Object.values(votes);
  const okCount = votesArray.filter(v => v === 'ok').length;
  const ngCount = votesArray.filter(v => v === 'ng').length;
  const isSuccess = (voters.length === 0) ? true : (okCount >= ngCount);
  
  const player = room.players.find(p => p.id === submitterId);
  const results = Object.keys(votes).map(vId => ({
    choice: votes[vId],
    color: room.players.find(p => p.id === vId)?.color || '#888'
  }));

  // クライアントに投票終了を通知（null送信でモーダルを閉じる）
  io.to(roomId).emit('startVote', null);

  if (player) {
    if (isSuccess) {
      if (room.options.star5) {
        // 承認 ＆ 星評価あり
        return startRatingPhase(room, roomId, submitterId, card, text, results);
      } else {
        // 承認 ＆ 星評価なし
        room.field.push({ 
          name: player.name, card, color: player.color, text,
          voteResults: results, rejected: false, likes: [] 
        });
      }
    } else {
      // ❌ 否決
      // 山札からペナルティを引く等の処理（中身がある前提）
      if (typeof rejectPlayedCard === 'function') {
          rejectPlayedCard(room, player, card); 
      } else {
          // 代替：手札に戻して山から1枚引く
          player.hand.push(card);
          if (room.deck.length > 0) player.hand.push(room.deck.shift());
      }
// 🚩 共通プロパティ
      const rejectedCard = { 
        name: player.name, card, color: player.color, text: text + " (否決)", 
        voteResults: results, rejected: true, likes: []
      };

      // 🚩 追加：★5評価がONの時だけ評価プロパティを付与する
      if (room.options.star5) {
        rejectedCard.starAverage = "0.0"; // 文字列で統一（描画バグを防ぐため）
        rejectedCard.ratings = [];
      }
      
      room.field.push(rejectedCard);
      io.to(submitterId).emit('dealCards', player.hand); 
    }

    io.to(roomId).emit('updateField', room.field);
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));

    io.to(roomId).emit('voteFinished', { 
        success: isSuccess, 
        okCount: okCount, 
        ngCount: ngCount, 
        nextIsRating: isSuccess && room.options.star5 
    });

    nextTurn(room, roomId);
  }
}
function normalizeKana(char) {
  if (!char) return "";

  // 🚩 1. どんな「ヴ」が来ても、まず「う」にしてしまう（最短ルート）
  // カタカナのヴ(\u30F4) も、万が一のひらがな ゔ も一括で「う」へ
  let c = char.replace(/[\u30F4ゔ]/g, 'う');

  // 2. その他のカタカナ → ひらがな
  c = c.replace(/[\u30A1-\u30F6]/g, match => {
    return String.fromCharCode(match.charCodeAt(0) - 0x60);
  });

  // 3. 小文字 → 大文字
  const smallToLarge = {
    'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お',
    'ゃ':'や','ゅ':'ゆ','ょ':'よ','っ':'つ','ゎ':'わ'
  };
  c = smallToLarge[c] ?? c;

  // 4. 濁点・半濁点除去（「ぱ」→「は」など）
  c = c.normalize('NFD').replace(/[\u3099\u309A]/g, '');

  // 5. 特殊ルール
  if (c === 'を') c = 'お';

  return c;
}

function getFirstKana(text) {
  for (const c of text) {
    // 🚩 範囲を \u30A1-\u30FA (ヴを含むカタカナ全域) に広げる
    if (/[\u3041-\u3096\u30A1-\u30FA]/.test(c)) return normalizeKana(c);
    if (/[一-龯]/.test(c)) return null; 
  }
  return null;
}

function getLastKana(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    // 🚩 同様にここも拡張
    if (/[\u3041-\u3096\u30A1-\u30FA]/.test(c)) return normalizeKana(c);
    if (/[一-龯]/.test(c)) return null;
  }
  return null;
}

function isValidShiritori(prevText, currentText, initialChar) {
  if (!currentText) {
    return { ok: false, type: 'invalid', reason: '文章を入力してください' };
  }

  if (currentText.length > 25) {
    return { ok: false, type: 'invalid', reason: '25文字以内にしてください' };
  }

const currFirst = getFirstKana(currentText); // 内部で normalizeKana 済み
  const currLast  = getLastKana(currentText);  // 内部で normalizeKana 済み

  // 1. 前の文字を特定
  let prevLastRaw = prevText ? getLastKana(prevText) : initialChar;
  
  // 2. 🚩 重要：サーバーからの initialChar かもしれないので、ここでもう一度正規化を通す
  const prevLastNormalized = normalizeKana(prevLastRaw);

  if (prevLastNormalized) {
    // 3. 🚩 正規化済み同士で比較
    if (prevLastNormalized !== currFirst) {
      return {
        ok: false,
        type: 'invalid',
        // エラーメッセージには「正規化前」の文字を出してあげると親切
        reason: `次は「${prevLastRaw}」からです`
      };
    }
  }

  return { ok: true, type: 'normal' };
}

//モードと入力データから新しいデッキ（シャッフル済み）と、マスターデータを生成する
function generateDeck(mode, images = [], rawTextDeck = "") {
    let finalDeck = [];
    let processedTextDeck = [];

    if (mode === 'word') {
        const hiragana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん！ー";
        hiragana.split('').forEach(c => {
            finalDeck.push(`text:${c}`, `text:${c}`);
        });
    } 
    else if (mode === 'chain') {
const base = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ";
    base.split('').forEach(c => finalDeck.push(`text:${c}`));
    finalDeck.push("text:わ"); // 1枚に絞る
    // 数字カード（文字数縛り）
    ["5", "6", "7+"].forEach(n => finalDeck.push(`text:${n}`, `text:${n}`));
    // 行カード
    ["あ行", "か行", "さ行", "た行", "な行", "は行", "ま行", "や行", "ら行"].forEach(r => finalDeck.push(`text:${r}`));
    // 🚩 【新ルール】列カード（母音縛り）
    ["あ列", "い列", "う列", "え列", "お列"].forEach(c => finalDeck.push(`text:${c}`));   } 
    else {
        // 持ち込み文章の処理
        if (rawTextDeck) {
            processedTextDeck = rawTextDeck.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line !== "")
                .map(line => `text:${line}`);
        }

        if (processedTextDeck.length > 0) {
            finalDeck = [...processedTextDeck];
        } else if (images.length > 0) {
            finalDeck = [...images];
        }
    }

    // シャッフル
    const shuffled = [...finalDeck].sort(() => Math.random() - 0.5);

    return {
        deck: shuffled,
        masterImages: images,
        masterTextDeck: processedTextDeck
    };
}

function exchangeHand(room, player, selectedCards) {
  if (player.isObserver) return;

  // 1. まず「手元からカードを抜く」
  selectedCards.forEach(cardPath => {
    const idx = player.hand.indexOf(cardPath);
    if (idx !== -1) {
      player.hand.splice(idx, 1);
    }
  });

  // 2. 「今の山札」をしっかりシャッフルする
  // これにより、今ある在庫からランダムに引けるようになる
  room.deck.sort(() => Math.random() - 0.5);

  const newCards = [];
  const countToExchange = selectedCards.length;

  // 3. 必要な枚数分、ループを回す
  for (let i = 0; i < countToExchange; i++) {
    // もし山札が空になったら、その瞬間に「今まで捨てられたカード」を山に戻して混ぜ直す
    if (room.deck.length === 0 && selectedCards.length > 0) {
      // まだ引けていない分があるのに山が切れたら、
      // 今回捨てたカード（selectedCards）を山に入れてシャッフル！
      room.deck.push(...selectedCards);
      room.deck.sort(() => Math.random() - 0.5);
      
      // 🚩 重要：二重に引かないよう、selectedCardsを空にする
      selectedCards = []; 
    }

    if (room.deck.length > 0) {
      newCards.push(room.deck.shift());
    }
  }

  // 4. 手札に加える
  player.hand.push(...newCards);

  // 5. 最後に、交換しきれず余った（本来の）捨て札を山に戻して混ぜる
  if (selectedCards.length > 0) {
    room.deck.push(...selectedCards);
    room.deck.sort(() => Math.random() - 0.5);
  }
}
// 🚩 いいね調整フェーズ開始
function startLikeCheckPhase(room, roomId) {
    room.finishedDecoCheckers = new Set();
    room.finishedLikeCheckers = new Set();

    if (!room.options || !room.options.like) {
        console.log("❤️ いいね調整OFFのためスキップします");
        // 🚩 修正：観戦者も含めた全員分を「完了」として扱う
        room.players.forEach(p => room.finishedLikeCheckers.add(p.id));
        advanceAfterLikeCheck(room, roomId); 
        return; 
    }

    room.phase = 'likeCheck';
    io.to(roomId).emit('phaseUpdated', 'likeCheck');
    io.to(roomId).emit('startLikeCheck', { field: room.field });
    io.to(roomId).emit('roomState', getRoomState(roomId));
}

// 🚩 いいね完了後の進捗
function advanceAfterLikeCheck(room, roomId) {
    // 🚩 修正：プレイヤーのみがボタンを押せば進むように変更
    const activePlayers = room.players.filter(p => !p.isObserver);
    
    // finishedLikeCheckers に入っている ID のうち、activePlayers に該当するものを数える
    const finishedActiveCount = Array.from(room.finishedLikeCheckers)
        .filter(id => activePlayers.some(p => p.id === id)).length;

    if (finishedActiveCount < activePlayers.length) return;

    room.finishedDecoCheckers = new Set();
    room.finishedLikeCheckers = new Set();

if (room.options && room.options.score100) {
    room.phase = 'rating'; 
    io.to(roomId).emit('phaseUpdated', 'rating');
    // totalPlayers を activePlayers.length (観戦者除き) に合わせる
    io.to(roomId).emit('startFinalRating', { totalPlayers: activePlayers.length }); 
} else {
        showFinalResult(room, roomId);
    }
}

// 🚩 星評価フェーズ開始（サーバー側）
function startRatingPhase(room, roomId, submitterId, card, text, voteResults) {
  const submitter = room.players.find(p => p.id === submitterId);
  
  // 🚩 修正：観戦者(isObserver)と提出者を除いたプレイヤーのみを「評価者」とする
  const evaluators = room.players.filter(p => !p.isObserver && p.id !== submitterId);
  const evaluatorIds = evaluators.map(p => p.id);
  
  room.currentRating = {
    submitterId,
    submitterName: submitter ? submitter.name : "退室したプレイヤー",
    card,
    text,
    voteResults,
    voters: evaluatorIds, // 👈 評価すべき人のリスト
    ratings: {}
  };
    
setTimeout(() => {
    // 🚩 追加：実行時に room や currentRating が消えていないかチェック
    if (!room || !room.currentRating) {
        console.log(`⚠️ [Room: ${roomId}] 評価データが消失したため通知をスキップします（一人プレイ等の可能性）`);
        return; 
    }

    io.to(roomId).emit('startRate', { 
      submitterId: submitterId,
      submitterName: room.currentRating.submitterName, 
      card, 
      text, 
      totalVoters: evaluatorIds.length,
      ratings: {},
      voters: evaluatorIds,
      deckCount: room.deck.length
    });
    
    io.to(roomId).emit('ratingUpdate', {
        ratedCount: 0,
        totalVoters: evaluatorIds.length
    });
    console.log(`📡 [Room: ${roomId}] Rating phase started and synced.`);
  }, 100);
}
// 🚩 投票フェーズ開始（サーバー側）
function startVotingPhase(room, roomId, submitterId, card, text) {
    const submitter = room.players.find(p => p.id === submitterId);
    
    // 観戦者と提出者を除いたプレイヤーを「投票者」とする
    const voteTargetPlayers = room.players.filter(p => !p.isObserver && p.id !== submitterId);
    const voterIds = voteTargetPlayers.map(p => p.id);

    // データのセット
    room.currentVote = {
        card: card,
        text: text || "",
        submitterId: submitterId,
        submitterName: submitter ? submitter.name : "退室したプレイヤー",
        voters: voterIds,
        votes: {}
    };

setTimeout(() => {
        // 🚩 【重要】実行時にデータが破棄されていないか必ずチェック！
        if (!room || !room.currentVote) {
            console.log(`⚠️ [Room: ${roomId}] 投票データが消失したため通知をスキップします（一人プレイ等の可能性）`);
            return;
        }

        io.to(roomId).emit('startVote', {
            submitterId: submitterId,
            submitterName: room.currentVote.submitterName, // 安全にアクセス可能
            card: card,
            text: text || "",
            totalVoters: voterIds.length,
            votes: {},
            voters: voterIds
        });

        io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
        io.to(roomId).emit('roomState', getRoomState(roomId));
        
        console.log(`📡 [Room: ${roomId}] Voting phase started: ${text}`);
    }, 100);
}

// ゲーム終了時の処理
function endGame(room, roomId) {
    room.phase = 'result';
    
    // 全員にフェーズ変更を通知
    io.to(roomId).emit('phaseUpdated', 'result');
    
    // 🚩 修正：観戦者を除いた「採点すべきプレイヤー」だけを数える
    const activePlayers = room.players.filter(p => !p.isObserver);
    const activeCount = activePlayers.length;

    // 100点評価がONなら入力フェーズへ
    if (room.options.score100) {
        // startFinalRating の引数名をフロントエンドが待っている名前に合わせる（通常は totalPlayers）
        io.to(roomId).emit('startFinalRating', { 
            totalPlayers: activeCount 
        });
        
        // 進捗状況を 0/X で初期化して通知
        io.to(roomId).emit('gameScoreUpdate', { 
            votedCount: 0, 
            totalPlayers: activeCount 
        });
    } else {
        // OFFなら即リザルト表示
        showFinalResult(room, roomId);
    }
}

function showFinalResult(room, roomId, avgScore = null) {
    // 🚩 1. 勝者（手札ゼロ、かつ参加者のみ）の抽出
    const winners = room.players
        .filter(p => !p.isObserver && p.hand.length === 0) 
        .map(p => ({
            name: p.name, color: p.color
        }));
    
    // 🚩 2. 全体の満足度（100点満点）の平均
    const scores = Object.values(room.gameRatings || {});
    const globalAvg = scores.length > 0 
        ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) 
        : (avgScore ? parseFloat(avgScore) : 0);

    // 🚩 3. プレイヤーごとの集計
// 🚩 修正案：playersData の作成時
const playersData = room.players
    .filter(p => !p.isObserver) // 観戦者をランキングから除外
    .map(p => {
const myCards = room.field.filter(f => 
    f.submitterId === p.id || f.name === p.name
);
        
        const totalLikes = myCards.reduce((sum, card) => sum + (card.likes ? card.likes.length : 0), 0);

        // 星評価の集計
        const ratedCards = myCards.filter(f => Object.prototype.hasOwnProperty.call(f, 'starAverage'));
        const myRatedCount = ratedCards.length;

        // p.scoreHistory が空の場合でも、field の starAverage から計算を試みる
        let starAvg = 0;
        if (myRatedCount > 0) {
            const sumStars = ratedCards.reduce((sum, c) => sum + parseFloat(c.starAverage || 0), 0);
            starAvg = parseFloat((sumStars / myRatedCount).toFixed(1));
        } else if (p.scoreHistory && p.scoreHistory.length > 0) {
            starAvg = parseFloat((p.scoreHistory.reduce((a, b) => a + b, 0) / p.scoreHistory.length).toFixed(1));
        }

        return {
            id: p.id,
            name: p.name,
            color: p.color,
            likes: totalLikes,
            starAvg: starAvg
        };
    });

// 🚩 4. 送信データ作成
    const resultData = {
        winners: winners,
        field: room.field,
        players: playersData,
        globalAvg: globalAvg,
        scoreDetails: Object.keys(room.gameRatings || {}).map(id => {
            const player = room.players.find(pl => pl.id === id);
            return { name: player ? player.name : "不明", score: room.gameRatings[id] };
        }),
        options: room.options
    };

    // 🚩 【重要】最新のリザルトデータをルームに保存する（同期用）
    room.lastResultData = resultData; 

    // 🚩 フェイズを ended に更新
    room.phase = 'ended';
    io.to(roomId).emit('phaseUpdated', 'ended');

    // リザルトデータを送信
    io.to(roomId).emit('finalResult', resultData);
}

function completeRating(room, roomId) {
    if (!room.currentRating) return;

    const { card, text, submitterId, ratings, voteResults } = room.currentRating;
    const player = room.players.find(p => p.id === submitterId);

    if (player) {
        // スコア計算
        const scores = Object.values(ratings);
        const average = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "0.0";

        // 場に追加
        room.field.push({
            name: player.name,
            card,
            color: player.color,
            text,
            voteResults,
            starAverage: average,
            rejected: false,
            likes: []
        });

        // 🚩 【重要】本人に「手札が減った（または0枚になった）」ことを確定させる！
        io.to(submitterId).emit('dealCards', player.hand); 

    } else {
        room.deck.push(card);
        room.deck.sort(() => Math.random() - 0.5);
    }

    // 状態クリア
    io.to(roomId).emit('ratingFinished', { submitterId: submitterId });
    io.to(roomId).emit('startRate', null);
    room.currentRating = null;

    // 同期
    io.to(roomId).emit('updateField', room.field);
io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));

    // 🚩 【最重要】ここで nextTurn を呼ぶ
    // この中で winner = players.find(p => p.hand.length === 0) が走り、
    // finishType === 'instant' なら終了フェーズへ飛ぶ
    nextTurn(room, roomId); 
}

// 🚩 星評価（★5）の完了チェック
function checkRatingComplete(room, roomId) {
    if (!room.currentRating) return;

    // 🚩 修正：観戦者を除いて分母を計算
    const activePlayers = room.players.filter(p => !p.isObserver);
    const voters = activePlayers.filter(p => p.id !== room.currentRating.submitterId);
    
    if (voters.length === 0) {
        // 1人プレイ時などの考慮
        completeRating(room, roomId);
        return;
    }

    const votedCount = Object.keys(room.currentRating.ratings).length;
    if (votedCount >= voters.length) {
        completeRating(room, roomId);
    } else {
        // 観戦者にも「今何人待ちか」が伝わるように emit
        io.to(roomId).emit('ratingUpdate', {
            votedCount: votedCount,
            totalVoters: voters.length
        });
    }
}

// 📊 満足度（100点）評価の完了チェック
function checkFinalRatingComplete(room, roomId) {
    if (!room.gameRatings) room.gameRatings = {};

    // 🚩 修正：採点すべき「実際のプレイヤー」のみを分母にする
    const activePlayers = room.players.filter(p => !p.isObserver);
    const totalNeeded = activePlayers.length;
    const votedCount = Object.keys(room.gameRatings).length;

    console.log(`📊 満足度採点チェック: ${votedCount} / ${totalNeeded}`);

    if (totalNeeded > 0 && votedCount >= totalNeeded) {
        const scores = Object.values(room.gameRatings);
        const average = scores.length > 0 
            ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) 
            : "0.0";
            
        showFinalResult(room, roomId, average);
        room.gameRatings = {}; 
    } else {
        // 🚩 ここも totalNeeded に合わせる
        io.to(roomId).emit('gameScoreUpdate', { 
            votedCount: votedCount, 
            totalPlayers: totalNeeded 
        });
    }
}

// プレイヤーリストを生成する共通関数を「超厳密」にする
function getCleanPlayerData(room) {
    return room.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isObserver: !!p.isObserver, // 確実にboolean
        // 🚩 観戦者なら絶対に手札枚数をnullにする。これがフロント側の判定基準になる
        cards: p.isObserver ? null : (p.hand ? p.hand.length : 0)
    }));
}

// 全ルーム管理
const rooms = {};


// ✅ 部屋作成（全モード対応：自動生成 or 持ち込みデッキ）
app.post('/create-room', upload.array('images', 50), async (req, res) => {
    try {
        const roomId = uuidv4().slice(0, 6);
        
        // 1. 画像ファイルを先に処理（これで Multer が req.body を解析完了する）
        let imagePaths = [];
        if (req.files && req.files.length > 0) {
            imagePaths = await processUploadedFiles(req.files);
        }

        // 🚩 2. ここで mode と textDeck を取得（Multer解析後なので確実に取れる）
        const mode = req.body.mode || 'mochicotori';
        const rawTextDeck = req.body.textDeck || "";
// 🚩 共通関数でデッキとマスターを生成
        const deckData = generateDeck(mode, imagePaths, rawTextDeck);
const config = MODE_SETTINGS[mode] || MODE_SETTINGS['mochicotori'];
        const initialOptions = { ...(config.defaults || config.options), mode: mode };

        rooms[roomId] = {
            id: roomId,
            mode: mode,
            options: initialOptions,
            phase: 'playing',
            firstPlayerId: null, // 🚩 追記：最初はまだ誰もいないので null
            images: imagePaths,
            textDeck: deckData.masterTextDeck,
            // 🚩 ここが重要：再戦時にここを参照する
            masterImages: deckData.masterImages,
            masterTextDeck: deckData.masterTextDeck,
            deck: deckData.deck, 
            field: [],
            players: [],
            messages: [],
            createdAt: Date.now()
        };

// 🚩 ここを修正！ finalDeck -> deckData.deck
        console.log(`🏠 部屋作成成功: ${roomId} [${mode}] デッキ:${deckData.deck.length}枚`);
        res.json({ roomUrl: `/room/${roomId}` });

    } catch (err) {
        console.error("部屋作成エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// 🚩 これ1つだけに絞ってください。他にある同じ名前の app.post は消してください。
app.post('/update-deck-and-start', upload.array('images', 50), async (req, res) => {
    // 1. req.body から必要な情報をすべて取り出す
    const { roomId, mode, options, name, color, textDeck } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "部屋なし" });

    try {
        const newImagePaths = await processUploadedFiles(req.files);
        
        // 新しい画像があれば保存
        if (newImagePaths.length > 0) {
            room.images = newImagePaths;
        }

        // 2. startGameLogic に渡す「data」オブジェクトをしっかり作る
        const startData = { 
            roomId: roomId,
            mode: mode, 
            options: JSON.parse(options),
            name: name,      // 🚩 第2引数の data に入れることで解決！
            color: color,    // 🚩 第2引数の data に入れることで解決！
            textDeck: textDeck, // 文デッキも渡す
            images: newImagePaths.length > 0 ? newImagePaths : null
        };

        // 3. 実行（第3引数は空のオブジェクトでもOKになります）
        startGameLogic(roomId, startData, {}); 

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Fetch開始エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// 🚩 fs の代わりに fs.promises を使うように冒頭で定義するか、以下のように記述
const fsPromises = require('fs').promises;

async function processUploadedFiles(files) {
    // 🚩 ライブラリ全体でキャッシュをオフにする（Windowsのファイルロック対策）
    sharp.cache(false);

    const imagePaths = [];
    for (const file of files) {
        const inputPath = file.path;
        const outPath = `uploads/${uuidv4()}.jpg`;

        try {
            // 🚩 対策：ファイルを直接開くのではなく、一度メモリ(Buffer)に読み込む
            // これにより、Sharpが実行されている間に inputPath を削除可能になります
            const buffer = await fsPromises.readFile(inputPath);

            const image = sharp(buffer); // Bufferから生成
            const metadata = await image.metadata();
            const size = Math.min(metadata.width, metadata.height);
            const left = Math.floor((metadata.width - size) / 2);
            const top = Math.floor((metadata.height - size) / 2);

            await image
                .extract({ left, top, width: size, height: size })
                .resize(300, 300)
                .toFormat('jpeg')
                .toFile(outPath);

            // 🚩 すでにBufferに読み込んでいるので、即座に安全に消せます
            await fsPromises.unlink(inputPath).catch(() => {});
            
            imagePaths.push(outPath);
        } catch (err) {
            console.error(`❌ ファイル処理エラー (${file.originalname}):`, err);
            if (fs.existsSync(inputPath)) {
                await fsPromises.unlink(inputPath).catch(() => {});
            }
        }
    }
    return imagePaths;
}

// ✅ 部屋ページ（全モード共通）
app.get('/room/:id', (req, res) => {
  const filePath = path.resolve(__dirname, 'public', 'shiritori', 'index.html');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('部屋ページが見つかりません');
  }
  res.sendFile(filePath);
});

// ✅ ソケット通信
io.on('connection', socket => {
  console.log('🟢 ユーザー接続');

// 入室処理
socket.on('joinRoom', ({ name, roomId, requestedRole }) => {
  const room = rooms[roomId];
  if (!room) {
    return socket.emit('joinError', '部屋が存在しません');
  }
    
room.players = room.players.filter(p => p.id !== socket.id);
    
  // 現在の参加者数（観戦者以外）をカウント
const activePlayers = room.players.filter(p => !p.isObserver);
const submittedCount = room.field.length; // (このターンの提出数)
  // ロックフェーズか確認
const isLockPhase = (room.phase === 'decoCheck' || room.phase === 'likeCheck' || room.phase === 'rating');
    
  // 🚩 ロール決定ロジック
let targetRole = requestedRole || 'player';

// 🚩 修正：観戦希望ならチェックを飛ばす
if (targetRole === 'player') {
    if (activePlayers.length >= 6) {
        return socket.emit('joinErrorNeedObserver', { reason: '満員のため' });
    }
    if (isLockPhase) {
        return socket.emit('joinErrorNeedObserver', { reason: '調整フェーズのため' });
    }
}

  // チェック通過、入室処理へ
  socket.join(roomId);
  socket.data.name = name;
  socket.data.roomId = roomId;

// 🚩 1. 観戦者フラグを先に決定する
  const isObserver = (requestedRole === 'observer');

  // 🚩 2. 色決めロジック（参加者の場合のみ実行）
  let color = null; 
  if (!isObserver) {
    const usedColors = room.players.map(p => p.color).filter(c => c); // nullを除外して取得
    color = getRandomColor(usedColors);
    socket.emit('assignColor', color);
    socket.data.color = color;
  } else {
// 🚩 観戦者の場合
  socket.data.color = null;
  socket.emit('assignColor', '#888888'); // ★ここに追加！観戦者にも「入室OK」の合図としてグレーを送る
  }

  // 手札配布ロジック
  const hand = [];
  // 「観戦者ではなく」かつ「プレイ中」なら配る
  // ※ waitingフェーズはなく playing スタート前提
  if (!isObserver && room.phase === 'playing') {
    for (let i = 0; i < 5; i++) {
      if (room.deck.length > 0) hand.push(room.deck.shift());
    }
  }

  const player = { 
    name, 
    id: socket.id, 
    hand: hand, 
    color: color,
    isObserver: isObserver 
  };
  room.players.push(player);

  // 履歴送信
  if (room.messages && room.messages.length > 0) {
    socket.emit('chatHistory', room.messages);
  }

  // 本人に手札送信（観戦者なら空配列が飛ぶ）
  socket.emit('dealCards', hand);
  socket.emit('updateField', room.field);
    
    // 🚩 追加：新しく入った人に、現在の「誰が観戦か」を即座に確定させる
  io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));

// 🚩 もし今「評価中」または「投票中」なら、新入室者にもパネルを出してあげる(ただし観戦者には出さない)
if (room.phase === 'playing') {
    // 1. 今動いているのが「評価」か「投票」かを確認
    const activeAction = room.currentRating || room.currentVote;

    if (activeAction) {
        // 🚩 最新の「投票すべき人数（分母）」を再計算
        // 提出者（submitterId）を除き、かつ観戦者（isObserver）でもない人の数
        const voters = room.players.filter(p => !p.isObserver && p.id !== (activeAction.submitterId || activeAction.drawerId));
        const latestTotal = voters.length;

        const eventName = room.currentRating ? 'startRate' : 'startVote';

        // 2. 【本人に送信】
        // 🚩 修正：観戦者（isObserver）にはイベントを送らない！
        if (!isObserver) {
            socket.emit(eventName, {
                ...activeAction,
                totalVoters: latestTotal, 
                deckCount: room.deck.length
            });
        }

        // 3. 【全員に送信】
        // 他のプレイヤー（既存の参加者）には、分母を更新するために送信が必要
        io.to(roomId).emit(eventName, {
            ...activeAction,
            totalVoters: latestTotal,
            deckCount: room.deck.length
        });
    }
}

// 全員にプレイヤーリスト更新（isObserverを含む）
io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
io.to(roomId).emit('roomState', getRoomState(roomId));
    
  // 入室メッセージ
const roleText = isObserver ? "（観戦）" : "";
  const msgColor = isObserver ? "#888888" : color; // 観戦者はグレー固定
  const joinMsg = { text: `${name} さんが入室しました！${roleText}`, color: msgColor };
  io.to(roomId).emit('message', joinMsg);
  room.messages.push(joinMsg);

// 🚩 しりとり文字の通知・初期化ロジック
if (room.options.shiritori) {
    // 1. まだ文字が決まっていない（ゲーム開始直後など）場合のみランダム決定
    if (!room.prevLast) {
        const chars = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ";
        room.prevLast = chars[Math.floor(Math.random() * chars.length)];
        // 全員に通知（これが実質的な開始合図になる）
        io.to(roomId).emit('message', { 
            text: `📢 最初の文字は「${room.prevLast}」です！`, 
            color: "#ff9800" 
        });
    } else {
        // 2. すでに文字が決まっているなら、入室した「本人」にだけ現在の文字を教える
        socket.emit('message', { 
            text: `📢 最初の文字は「${room.prevLast}」です！`, 
            color: "#ff9800" 
        });
    }
}

// 🚩 新入室者が「ended」フェーズの部屋に入った場合、リザルトデータを同期する
if (room.phase === 'ended') {
    // すでに終わっているなら、保存されているデータを本人にだけ送る
    if (room.lastResultData) {
        socket.emit('finalResult', room.lastResultData);
    } else {
        // 万が一データがまだ生成されていなければ、再生成して全員（または本人）に送る
        showFinalResult(room, roomId);
    }
}  
    
// 1. まず部屋の基本状態を確定させる
validateAndSyncFirstPlayer(room);

// 2. 本人に roomState を送る（基本設定、オプション、フェーズなどを同期）
// ※ これを最初に行うことで、クライアント側の初期化を先に終わらせる
socket.emit('roomState', getRoomState(roomId));

// 3. その後、最新の「手番（ターン）」を 全員 に送る
// ※ これを最後にすることで、クライアント側で確実に「あなたのターン」が上書き表示される
if (room.turnIndex === undefined || room.turnIndex === null) {
    room.turnIndex = 0;
}

// 🚩 参加者のみのリストから現在の手番プレイヤーを特定
const playersOnly = room.players.filter(p => !p.isObserver);
const turnPlayer = playersOnly[room.turnIndex];

io.to(roomId).emit('turnUpdate', {
    turnIndex: room.turnIndex,
    currentPlayerId: turnPlayer ? turnPlayer.id : null,
    currentPlayerName: turnPlayer ? turnPlayer.name : "待機中..."
});
});

// ロール切り替え処理
socket.on('switchRole', ({ targetRole }) => {
  const { roomId } = socket.data;
  const room = rooms[roomId];
  if (!room) return;

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return;

  // 1. 中間フェーズのみロック（endedは含めない）
  const isLockPhase = (room.phase === 'decoCheck' || room.phase === 'likeCheck' || room.phase === 'rating');
  if (isLockPhase) {
    return socket.emit('errorMessage', '調整中・採点中は席を移動できません');
  }

// ゲーム終了フェイズの場合
if (room.phase === 'ended') {
    const isBecomingObserver = (targetRole === 'observer');
    
    // 1. フラグとリソースの更新
    player.isObserver = isBecomingObserver;
    
    if (isBecomingObserver) {
        player.color = null;
        player.hand = [];
    } else {
        // 参加者に戻る場合、色を再割り当て
        if (!player.color) {
            const usedColors = room.players.map(p => p.color).filter(c => c);
            player.color = getRandomColor(usedColors);
        }
    }

    // 🚩 重要：リスト内での位置を整理する（参加者は前、観戦者は後ろなど、通常時と同じ動きをさせる）
    // 一度削除して
    room.players = room.players.filter(p => p.id !== socket.id);
    // モードに合わせて追加（参加なら最後尾、観戦ならリスト操作のルールに従う）
    room.players.push(player); 

    // 起家の確認
    const newFirstPlayerId = validateAndSyncFirstPlayer(room);

    // 全員に通知
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
    io.to(roomId).emit('firstPlayerUpdate', { firstPlayerId: newFirstPlayerId });

    // 🚩 本人に roomState を送る（これで refreshRoleUI(isObs) が走る）
    socket.emit('roomState', getRoomState(roomId));
    return; 
}

  if (targetRole === 'player') {
    // 観戦 → 参加
// 🚩 1. 参加者だけのリストを一度作り、そこから現在のターンプレイヤーを特定する
    const playersOnlyBefore = room.players.filter(p => !p.isObserver);
    const currentTurnPlayerId = playersOnlyBefore[room.turnIndex]?.id;

    // 2. 自分を一旦消して最後尾に追加
    room.players = room.players.filter(p => p.id !== socket.id);
    player.isObserver = false;
    room.players.push(player);
    // ✅ ここで全員にリストを通知
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));

    // 🚩 3. 参加者リストを作り直し、メモしたIDの「新しい位置」を探す
const playersOnlyAfter = room.players.filter(p => !p.isObserver);
const newTurnIndex = playersOnlyAfter.findIndex(p => p.id === currentTurnPlayerId);

if (newTurnIndex !== -1) {
    room.turnIndex = newTurnIndex;
}

const turnOwner = playersOnlyAfter[room.turnIndex];  io.to(roomId).emit('turnUpdate', {
        turnIndex: room.turnIndex,
        currentPlayerId: turnOwner ? turnOwner.id : null,
        currentPlayerName: turnOwner ? turnOwner.name : "待機中..."
    });
    
    // 🚩 追加：色を持っていない場合はここで割り当てる
    if (!player.color) {
      const usedColors = room.players.map(p => p.color).filter(c => c);
      const newColor = getRandomColor(usedColors);
      player.color = newColor;
      socket.data.color = newColor;
      socket.emit('assignColor', newColor); // クライアントに自分の色を通知
    }  
      
    // 手札がなければ配る
    if (player.hand.length === 0 && room.deck.length > 0) {
       for (let i = 0; i < 5; i++) {
         if (room.deck.length > 0) player.hand.push(room.deck.shift());
       }
       socket.emit('dealCards', player.hand);
    }
    
    // メッセージ
    const msg = { text: player.name + " さんが参加するってよ、グッドラック✨", color: player.color };
    io.to(roomId).emit('message', msg);
    room.messages.push(msg);
    
    // 🚩 全員にプレイヤーリストを更新
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
    
    // 🚩 ここでも本人以外には roomState を送らず、必要な情報だけをバラ撒く
    const newFirstPlayerId = validateAndSyncFirstPlayer(room);
    io.to(roomId).emit('firstPlayerUpdate', { firstPlayerId: newFirstPlayerId });
    
    // 本人には roomState を送り、手札描画などを走らせる
    socket.emit('roomState', getRoomState(roomId));
    return; // 関数の最後にある一括送信を避けるため return
} else {
    // --- 参加 → 観戦 ---
    const oldIndex = room.turnIndex;
    const playersOnlyBefore = room.players.filter(p => !p.isObserver);
    const wasTurnOwner = (playersOnlyBefore[oldIndex]?.id === socket.id);
    
    // 1. 観戦状態に切り替え
    player.isObserver = true;

    // 👑 起家の更新（ここで2番目の人が新起家 ID になる）
    validateAndSyncFirstPlayer(room);

    const playersOnlyAfter = room.players.filter(p => !p.isObserver);

    if (playersOnlyAfter.length === 0) {
        io.to(roomId).emit('roomState', getRoomState(roomId));
        return;
    }

    // 2. ターンの進行ロジックの修正
    if (room.options.turnBased) {
        if (wasTurnOwner) {
            // 🚩 修正：nextTurn() を呼ばず、その場のインデックスを維持する
            // 抜けた人が配列から消えるため、同じIndexを指せば自動的に「次の人」を指すことになる
            room.turnIndex = oldIndex % playersOnlyAfter.length;
            
            // 🚩 ここで手番情報を全員に通知（スキップ処理はせず、今の人を手番にする）
            const newTurnPlayer = playersOnlyAfter[room.turnIndex];
            io.to(roomId).emit('turnUpdate', {
                turnIndex: room.turnIndex,
                currentPlayerId: newTurnPlayer ? newTurnPlayer.id : null,
                currentPlayerName: newTurnPlayer ? newTurnPlayer.name : "待機中..."
            });
        } else {
            // 自分の番でないなら、現在の手番プレイヤーのIDを追跡して位置を再計算
            const currentPlayerId = playersOnlyBefore[oldIndex]?.id;
            const newIndex = playersOnlyAfter.findIndex(p => p.id === currentPlayerId);
            room.turnIndex = (newIndex !== -1) ? newIndex : 0;
        }
    }
    // 3. 退出者の資源（手札・いいね）を処理
    if (player.hand && player.hand.length > 0) {
        room.deck.push(...player.hand);
        room.deck.sort(() => Math.random() - 0.5);
        player.hand = [];
    }

    socket.emit('dealCards', []);

if (room.field) {
        room.field.forEach(card => {
            // card.likes が存在する場合のみ、自分のIDを除外
            if (Array.isArray(card.likes)) {
                card.likes = card.likes.filter(id => id !== socket.id);
            }
        });
        io.to(roomId).emit('updateField', room.field);
    }

    player.isObserver = true;
    player.color = null;
    socket.data.color = null;
      
    
// 🚩 観戦メッセージはグレー固定
    const msg = { text: player.name + " さんが観戦席に移りました。", color: "#888888" };
    io.to(roomId).emit('message', msg);
    room.messages.push(msg);

// 🚩 全員にプレイヤーリストを更新
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
    
    // 起家情報を全員に通知
    io.to(roomId).emit('firstPlayerUpdate', { firstPlayerId: room.firstPlayerId });

    // 本人には roomState を送る
    socket.emit('roomState', getRoomState(roomId));
    return; // 関数の最後にある一括送信を避けるため return
  }

// ✅ getCleanPlayerData を使って全員に通知
  io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
//  io.to(roomId).emit('roomState', getRoomState(roomId));
});
 
// 🎴 カード提出（しりとり判定・手札管理・投票開始）
socket.on('playCard', ({ card, text }) => {
  console.log("📥 カード受信:", { card, text });
  const { roomId, name } = socket.data;
  const room = rooms[roomId];
  const player = room.players.find(p => p.id === socket.id);
if (!player || player.isObserver) return; // 🚩 観戦者は何もしない（player存在チェックと合わせるのが安全）
  const clean = (p) => p.startsWith('/') ? p.slice(1) : p;
  const actualCardPath = player.hand.find(h => clean(h) === clean(card));

    
    console.log("=== 🚨 緊急調査 🚨 ===");
  console.log("1. 送信者のID:", socket.id);
  console.log("2. サーバーが認識している roomId:", roomId);
  // ✅ 今度はエラーになりません
  console.log("3. ルームは存在するか:", room ? "✅ あり" : "❌ なし");
    
    
  if (!player) return;
//  if (!room || room.currentVote) return;
//    if (room.currentVote) return; // 🚩 投票中は受け付けない

  // 1. ターンチェック
if (room.options.turnBased) {
    const playersOnly = room.players.filter(p => !p.isObserver);
    const currentPlayer = playersOnly[room.turnIndex]; // room.players ではなく playersOnly を見る

    if (currentPlayer && currentPlayer.id !== socket.id) {
        socket.emit('errorMessage', '今はあなたの番ではありません');
        return;
    }
}
    

  console.log("👤 プレイヤー手札:", JSON.stringify(player.hand));
  console.log("🎴 照合結果:", actualCardPath ? "一致" : "不一致");

  if (!actualCardPath) {
    console.log("❌ 手札にそのカードがないため拒否されました");
    return;
  }
    
    
  // 2. しりとりバリデーション（ONの時だけ）
  if (room.options.shiritori) {
    const validCards = room.field.filter(c => !c.rejected);
    const prevText = validCards.length > 0 ? validCards.at(-1).text : '';
    const result = isValidShiritori(prevText, text, room.prevLast);

    if (!result.ok && result.type === 'invalid') {
      socket.emit('errorMessage', result.reason);
      return; 
    }

if (result.type === 'endsWithN') {
    const lostCard = {
        name: player.name, 
        card: actualCardPath, 
        color: player.color, 
        text: text + " (「ん」終了)",
        rejected: true, 
        likes: []
    };
    // オプションが有効な時だけ、評価用のプロパティを持たせる
    if (room.options.star5) {
        lostCard.starAverage = "0.0";
        lostCard.voteResults = []; 
    }
    room.field.push(lostCard);
      player.hand.splice(player.hand.indexOf(actualCardPath), 1);
      if (room.deck.length > 0) player.hand.push(room.deck.shift());
      
      io.to(roomId).emit('updateField', room.field);
      socket.emit('dealCards', player.hand);
io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
      io.to(roomId).emit('roomState', getRoomState(roomId));
      nextTurn(room, roomId);
      return;
    }
  }
    
// 🪓 手札削除・状態更新へ（ここから入れ替え）
        console.log("🪓 手札削除・状態更新へ");
        player.hand.splice(player.hand.indexOf(actualCardPath), 1);
        socket.emit('dealCards', player.hand);

        // 投票相手のリストを定義
        const voteTargetPlayers = room.players.filter(p => p.id !== socket.id && !p.isObserver);

        // 🟢 条件分岐を「else if」で繋いで、どれか1つしか実行されないようにする
        if (!room.options.vote && !room.options.star5) {
            // 【1】投票も星もなし
            const newCard = { name: player.name, card: actualCardPath, color: player.color, text, rejected: false, likes: [] };
            room.field.push(newCard);
            io.to(roomId).emit('updateField', room.field);
            nextTurn(room, roomId);
        } 
        else if (!room.options.vote && room.options.star5) {
            // 【2】評価モード（投票なし）
            startRatingPhase(room, roomId, socket.id, actualCardPath, text, []);
        } 
else {
    // 【3】投票モード
    console.log("【3】投票モード実行");
    const voteTargetPlayers = room.players.filter(p => p.id !== socket.id && !p.isObserver);

    if (voteTargetPlayers.length === 0) {
        // 相手がいない場合は即時承認
        const newCard = { name: player.name, card: actualCardPath, color: player.color, text, rejected: false, likes: [] };
        room.field.push(newCard);
        io.to(roomId).emit('updateField', room.field);
        nextTurn(room, roomId);
    } else {
        // 🚩 自作の関数を呼び出す！
        startVotingPhase(room, roomId, socket.id, actualCardPath, text);
    }
}
        // （ここまで入れ替え）

    });

socket.on('castVote', ( vote ) => {
    // 🚩 修正：roomId の取り方をログで確認しつつ確実に取得する
    const roomId = socket.roomId || socket.data?.roomId; 
    const room = rooms[roomId];

    console.log(`🗳️ castVote受信: Room=${roomId}, User=${socket.id}, Vote=${vote}`);

    if (!room) {
        console.error("❌ roomが見つかりません:", roomId);
        return;
    }
    if (!room.currentVote) {
        console.error("❌ 現在投票中ではありません");
        return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (player?.isObserver) return;

    if (room.currentVote.votes[socket.id]) return;

    room.currentVote.votes[socket.id] = vote;
    const votedCount = Object.keys(room.currentVote.votes).length;
    const totalVoters = room.currentVote.voters.length;

    console.log(`📊 投票状況: ${votedCount} / ${totalVoters}`); // これが 1/1 になるか確認

    io.to(roomId).emit('voteUpdate', { votedCount, totalVoters });

if (votedCount >= totalVoters) {
    console.log("✅ 全員の投票が完了しました。フェーズを移行します。");

    // 🚩 修正：nullを送るのではなく、結果を集計して voteFinished を送る
    const votes = Object.values(room.currentVote.votes);
    const okCount = votes.filter(v => v === 'ok').length;
    const ngCount = votes.filter(v => v === 'ng').length;

    io.to(roomId).emit('voteFinished', {
        success: okCount > ngCount,
        okCount: okCount,
        ngCount: ngCount,
        nextIsRating: true // 次のフェーズへ行く合図
    });

    // 🚩 修正：startVote(null) は送らない（クライアントのエラーの元）
    // io.to(roomId).emit('startVote', null); 
    
    (room, roomId);
}
});
    
    // ⭐ 星評価を受け取る処理
socket.on('castRating', (stars) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
// 🚩 ここでまず player を定義する必要があります！
    const player = room?.players.find(p => p.id === socket.id);
if (!room || !room.currentRating || player?.isObserver) return; // 🚩 追記

    const ratingObj = room.currentRating;

    // 出した本人は評価できない（念のためのサーバー側ガード）
    if (socket.id === ratingObj.submitterId) return;

    // 評価を記録（1人1回まで）
    ratingObj.ratings[socket.id] = stars;

    const votedCount = Object.keys(ratingObj.ratings).length;
    const totalNeeded = ratingObj.voters.length;

    // 進捗を全員に通知
// 🟢 修正：クライアントが期待する変数名「votedCount」を確実に含める
// また、startRate も飛ばして確実に同期させる
io.to(roomId).emit('ratingUpdate', {
    votedCount: votedCount, // ratedCount だけでなく votedCount も送る
    ratedCount: votedCount,
    totalVoters: totalNeeded
});
      io.to(roomId).emit('startRate', ratingObj); // 状態を同期

    // 全員（本人以外）が評価し終えたら完了処理へ
    if (votedCount >= totalNeeded) {
        io.to(roomId).emit('roomState', getRoomState(roomId));
      completeRating(room, roomId);
    }
  });

// --- 100点満点評価の集計ロジック ---
socket.on('castGameScore', (score) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    // 🚩 1. player を定義する（ReferenceError 対策）
    const player = room.players.find(p => p.id === socket.id);

    // 🚩 2. ガード（部屋設定、プレイヤー存在確認、観戦者除外）
    if (!room.options.score100 || !player || player.isObserver) return;

    if (!room.gameRatings) room.gameRatings = {};
    
    // スコアを保存
    room.gameRatings[socket.id] = parseInt(score);

    // 🚩 3. 「参加者（非観戦者）」のリストを作成
    const activePlayers = room.players.filter(p => !p.isObserver);
    const totalNeeded = activePlayers.length; // 必要な採点数
    const votedCount = Object.keys(room.gameRatings).length; // 現在の採点数

    console.log(`📊 満足度採点中: ${votedCount} / ${totalNeeded} (送信者: ${player.name})`);

    // 進捗を全員に通知（分母を activePlayers に合わせる）
    io.to(roomId).emit('gameScoreUpdate', {
        votedCount: votedCount,
        totalPlayers: totalNeeded
    });

    // 🚩 4. 参加者全員が揃ったら結果発表
    if (totalNeeded > 0 && votedCount >= totalNeeded) {
        const scores = Object.values(room.gameRatings);
        const average = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
        
        showFinalResult(room, roomId, average);
        room.gameRatings = {}; // リセット
    }
});

// 🔌 切断時の処理
socket.on('disconnect', (reason) => {
    const { roomId, name: playerName } = socket.data;
    if (!roomId || !rooms[roomId]) return;

    console.log(`📡 切断検知: ID=${socket.id}, 名前=${playerName}, 理由=${reason}`);
    const room = rooms[roomId];

// 🚩 追加：判定用に「消える前」の手番プレイヤーIDを記録しておく
    const activePlayersBefore = room.players.filter(p => !p.isObserver);
    const oldTurnPlayerId = activePlayersBefore[room.turnIndex]?.id;

    console.log(`📡 切断検知: ID=${socket.id}, 名前=${playerName}, 理由=${reason}`);    
    
    // 1. プレイヤーを特定して削除
    const foundIndex = room.players.findIndex(p => p.id === socket.id);
    if (foundIndex === -1) return;

    const player = room.players[foundIndex];
    room.players.splice(foundIndex, 1); // ここで配列から消える

// 🚩 共通関数を呼ぶだけ！
validateAndSyncFirstPlayer(room);

const activePlayers = room.players.filter(p => !p.isObserver);
if (activePlayers.length === 0) {
        console.log(`🧹 部屋 ${roomId} が無人になったためリセットします`);
        resetRoomToDefault(roomId);
        return;
    }

    // 3. 退出者の資源（手札・いいね）を処理
    if (player.hand && player.hand.length > 0) {
        room.deck.push(...player.hand);
        room.deck.sort(() => Math.random() - 0.5);
    }
    if (room.field) {
        room.field.forEach(card => {
            if (card.likes) card.likes = card.likes.filter(id => id !== socket.id);
        });
        io.to(roomId).emit('updateField', room.field);
    }

    // 4. 投票中のレスキュー
    if (room.currentVote) {
        if (room.currentVote.submitterId === socket.id) {
            // 提出者が消えたら投票中止
            const cardToReturn = room.currentVote.card;
            if (cardToReturn) {
                room.deck.push(cardToReturn);
                room.deck.sort(() => Math.random() - 0.5);
            }
            room.currentVote = null;
            io.to(roomId).emit('voteFinished', { success: false, reason: "提出者が退出しました" });
        } else {
            // 投票待ちリストから削除して分母を更新
            room.currentVote.voters = room.currentVote.voters.filter(id => id !== socket.id);
            delete room.currentVote.votes[socket.id];
            const votedCount = Object.keys(room.currentVote.votes).length;
            const totalVoters = room.currentVote.voters.length;
            io.to(roomId).emit('voteUpdate', { votedCount, totalVoters });
            if (totalVoters === 0 || votedCount >= totalVoters) completeVote(room, roomId);
        }
    }

// --- 🚩 追記：起家の引き継ぎロジック ---
    const wasFirstPlayer = (room.firstPlayerId === socket.id);
    if (wasFirstPlayer) {
        // 残っている参加者（activePlayers）の中から新しい起家を決める
        const nextActive = activePlayers[0]; // 配列の先頭の人
        room.firstPlayerId = nextActive ? nextActive.id : null;
        console.log(`👑 切断のため起家を引き継ぎました: ${room.firstPlayerId}`);
    }    
    
// --- 5. ターン順の調整 ---
if (activePlayers.length > 0) {
    const wasTurnOwner = (room.options.turnBased && oldTurnPlayerId === socket.id);

    if (room.turnIndex >= activePlayers.length) {
        room.turnIndex = 0;
    }

    if (wasTurnOwner && room.phase === 'playing') {
        // 🚩 自分の番で落ちたなら、審判(nextTurn)を呼んで次の人を確定・終了判定させる
        nextTurn(room, roomId);
    } else {
        // 手番以外が落ちたなら、今の currentPlayerName などを再通知するだけでOK
        const nextPlayer = activePlayers[room.turnIndex];
        io.to(roomId).emit('turnUpdate', {
            turnIndex: room.options.turnBased ? room.turnIndex : -1,
            currentPlayerId: room.options.turnBased ? (nextPlayer?.id || null) : null,
            currentPlayerName: room.options.turnBased ? (nextPlayer?.name || "待機中") : "全員"
        });
    }
}

    // 6. 各種フェーズの「詰み」防止チェック
    // --- DecoCheck (文字調整) ---
    if (room.phase === 'decoCheck' && room.finishedDecoCheckers) {
        room.finishedDecoCheckers.delete(socket.id);
        // 参加者が全員完了したか（参加者がいなくなっても次へ）
        if (activePlayers.length === 0 || room.finishedDecoCheckers.size >= activePlayers.length) {
            startLikeCheckPhase(room, roomId);
        }
    }
    // --- LikeCheck (いいね調整) ---
    if (room.phase === 'likeCheck' && room.finishedLikeCheckers) {
        room.finishedLikeCheckers.delete(socket.id);
        advanceAfterLikeCheck(room, roomId);
    }
    // --- Rating (★5評価) ---
    if (room.currentRating) {
        if (room.currentRating.submitterId === socket.id) {
            // 評価対象者が消えたら中止
            room.currentRating = null;
            io.to(roomId).emit('startRate', null);
        } else {
            checkRatingComplete(room, roomId);
        }
    }
    // --- Final Rating (100点満点) ---
    if (room.phase === 'rating' && room.options.score100) {
        checkFinalRatingComplete(room, roomId);
    }

    // 7. 全員に最終的な同期データを送る
    io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));
// すでに getRoomState(roomId) の中で firstPlayerId は含まれているはずですが、
    // 明示的に送るなら、存在する変数 room.firstPlayerId を使います。
    io.to(roomId).emit('roomState', {
        ...getRoomState(roomId),
        firstPlayerId: room.firstPlayerId 
    });
    io.to(roomId).emit('message', { text: `📢 ${playerName} さんが退室しました。`, color: "#888" });
});

//　　ゲーム開始ボタン
socket.on('startGame', (data) => {
    // 部屋IDの候補をすべて渡して、ロジック側で判断させる
    const roomIdCandidate = socket.roomId || data.roomId;
    startGameLogic(roomIdCandidate, data, socket);
});
    
socket.on('watchRoom', (roomId) => {
    const room = rooms[roomId];
    if (room) {
      socket.emit('roomState', { 
        mode: room.mode,
        options: room.options,
          phase: room.phase,
      prevLast: room.prevLast
      });
    }
  });

    // 🟢 パス
socket.on('passTurn', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    const player = room?.players.find(p => p.id === socket.id);
if (!room || player?.isObserver) return;

    // ターン制なら、自分の番かチェック
    if (room.options.turnBased) {
      const currentPlayer = room.players[room.turnIndex];
      if (currentPlayer.id !== socket.id) return;
    }

    io.to(roomId).emit('message', { text: `📢 ${socket.data.name} さんがパスしました。`, color: "#888" });
    nextTurn(room, roomId);
  });

  // 🟢 手札交換
socket.on('exchangeCards', (selectedCards) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    const player = room?.players.find(p => p.id === socket.id);
if (!room || !selectedCards || player?.isObserver) return; // 🚩 追記

    // 🚩 ゲーム設定で「手札交換」が許可されているかチェック
    if (!room.options.exchange) return;

    // 🚩 ターン制の場合のみ、手番チェックを行う
    if (room.options.turnBased) {
        const currentPlayer = room.players[room.turnIndex];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;
    }

    if (!player) return;

    // カード交換処理（既存の関数を利用）
    exchangeHand(room, player, selectedCards);

    // 本人に新しい手札を送信
    socket.emit('dealCards', player.hand);
    // 全員に山札の残り枚数と、そのプレイヤーの手札枚数変化を通知
    io.to(roomId).emit('roomState', getRoomState(roomId));
io.to(roomId).emit('updatePlayers', getCleanPlayerData(room));

    io.to(roomId).emit('message', { 
        text: `🔄 ${player.name} さんがカードを${selectedCards.length}枚交換しました。`, 
        color: "#888" 
    });

    // 🚩 ターン制の場合のみ、次の人へ回す
    if (room.options.turnBased) {
        nextTurn(room, roomId);
    // 📢 ここが重要！最新のターン情報を全員に送り直す
        io.to(roomId).emit('roomState', getRoomState(roomId));
    }
    // 非ターン制なら、ここで処理終了（順番は変わらず、引き続き全員がプレイ可能）
});
    
    // 🚩 文字の変換テーブル
const charVariations = {
    // --- あ行 ---
    'あ': ['あ', 'ぁ', 'ア', 'ァ'],
    'い': ['い', 'ぃ', 'イ', 'ィ'],
    'う': ['う', 'ぅ', 'ヴ', 'ウ', 'ゥ'],
    'え': ['え', 'ぇ', 'エ', 'ェ'],
    'お': ['お', 'ぉ', 'オ', 'ォ','を', 'ヲ'],

    // --- か行 ---
    'か': ['か', 'が', 'カ', 'ガ'],
    'き': ['き', 'ぎ', 'キ', 'ギ'],
    'く': ['く', 'ぐ', 'ク', 'グ'],
    'け': ['け', 'げ', 'ケ', 'ゲ'],
    'こ': ['こ', 'ご', 'コ', 'ゴ'],

    // --- さ行 ---
    'さ': ['さ', 'ざ', 'サ', 'ザ'],
    'し': ['し', 'じ', 'シ', 'ジ'],
    'す': ['す', 'ず', 'ス', 'ズ'],
    'せ': ['せ', 'ぜ', 'セ', 'ゼ'],
    'そ': ['そ', 'ぞ', 'ソ', 'ゾ'],

    // --- た行 ---
    'た': ['た', 'だ', 'タ', 'ダ'],
    'ち': ['ち', 'ぢ', 'チ', 'ヂ'],
    'つ': ['つ', 'っ', 'づ', 'ツ', 'ッ', 'ヅ'],
    'て': ['て', 'で', 'テ', 'デ'],
    'と': ['と', 'ど', 'ト', 'ド'],

    // --- な行 ---
    'な': ['な', 'ナ'], 'に': ['に', 'ニ'], 'ぬ': ['ぬ', 'ヌ'], 'ね': ['ね', 'ネ'], 'の': ['の', 'ノ'],

    // --- は行 (濁点・半濁点) ---
    'は': ['は', 'ば', 'ぱ', 'ハ', 'バ', 'パ','わ', 'ゎ', 'ワ', 'ヮ'],
    'ひ': ['ひ', 'び', 'ぴ', 'ヒ', 'ビ', 'ピ'],
    'ふ': ['ふ', 'ぶ', 'ぷ', 'フ', 'ブ', 'プ'],
    'へ': ['へ', 'べ', 'ぺ', 'ヘ', 'ベ', 'ペ'],
    'ほ': ['ほ', 'ぼ', 'ぽ', 'ホ', 'ボ', 'ポ'],

    // --- ま・や・ら・わ行 その他---
    'ま': ['ま', 'マ'], 'み': ['み', 'ミ'], 'む': ['む', 'ム'], 'め': ['め', 'メ'], 'も': ['も', 'モ'],
    'や': ['や', 'ゃ', 'ヤ', 'ャ'],
    'ゆ': ['ゆ', 'ゅ', 'ユ', 'ュ'],
    'よ': ['よ', 'ょ', 'ヨ', 'ョ'],
    'ら': ['ら', 'ラ'], 'り': ['り', 'リ'], 'る': ['る', 'ル'], 'れ': ['れ', 'レ'], 'ろ': ['ろ', 'ロ'],
    'わ': ['わ', 'ゎ', 'ワ', 'ヮ', 'は','ハ'], 'を': ['を', 'ヲ','お', 'ぉ', 'オ', 'ォ'], 'ん': ['ん', 'ン'],
    'ー': ['ー', '～'],
    '！': ['！','！！', '？','？？', '！？', '？！','、','。','w']
};

// 　文字装飾
socket.on('toggleTextDecoration', ({ cardIndex }) => {
    const { roomId } = socket.data; 
    const room = rooms[roomId];
    const player = room?.players.find(p => p.id === socket.id);
if (!room || player?.isObserver) return; // 🚩 追記

    // 🚩 重要：targetCard をここで定義
    const targetCard = room.field[cardIndex];
    if (!targetCard) return;

    // 🚩 フェーズチェック（decoCheck中も許可）
    const canDecorate = (room.phase === 'playing' || room.phase === 'decoCheck');
    if (!canDecorate) return;

    const currentVal = targetCard.card || targetCard.text || "";
    const charOnly = currentVal.replace('text:', '');

    let foundList = null;
    for (const key in charVariations) {
        if (charVariations[key].includes(charOnly)) {
            foundList = charVariations[key];
            break;
        }
    }

    if (foundList) {
        const currentIndex = foundList.indexOf(charOnly);
        const nextIndex = (currentIndex + 1) % foundList.length;
        const nextChar = foundList[nextIndex];

        // データの更新
        if (typeof targetCard.card === 'string' && targetCard.card.startsWith('text:')) {
            targetCard.card = 'text:' + nextChar;
        } else {
            targetCard.text = nextChar;
        }

console.log("✅ 文字更新 [Room:" + roomId + "]: " + charOnly + " -> " + nextChar);
io.to(roomId).emit('updateField', room.field);
    }
});
    
    // 💖 いいね（ハート）のトグル処理
socket.on('toggleLike', ({ cardIndex }) => {
  const { roomId } = socket.data;
  const room = rooms[roomId];
  if (!room || !room.options.like) return;

  const targetCard = room.field[cardIndex];
  if (!targetCard) return;

  if (!targetCard.likes) targetCard.likes = [];

  // 🔴 修正：色の代わりに ID (socket.id) を使う
const myId = socket.id; // 🔴 IDを使う
  const existingIndex = targetCard.likes.indexOf(myId);

  if (existingIndex > -1) {
    targetCard.likes.splice(existingIndex, 1); // すでに押してたら消す
  } else {
    targetCard.likes.push(myId); // まだなら追加
  }

  io.to(roomId).emit('updateField', room.field);
});
    
    // 装飾チェック完了時
socket.on('finishDecoCheck', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);

// 🚩 プレイヤー本人のデータにフラグを立てる
    player.hasFinishedDecoCheck = true;

    // 観戦者は完了ボタンを押せないのでガード
    if (!player || player.isObserver) return;

    if (!room.finishedDecoCheckers) room.finishedDecoCheckers = new Set();
    room.finishedDecoCheckers.add(socket.id);

    // 🚩 参加者のみのリストを取得
    const activePlayers = room.players.filter(p => !p.isObserver);

    console.log(`✅ 文字調整完了: ${socket.data.name} (${room.finishedDecoCheckers.size}/${activePlayers.length})`);

    // 🚩 判定の分母を activePlayers.length に変更
    if (room.finishedDecoCheckers.size >= activePlayers.length) {
        room.finishedDecoCheckers = new Set(); 
        startLikeCheckPhase(room, roomId); 
    }
});
    
    // ボタン押下時の処理はこれだけ
socket.on('finishLikeCheck', () => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;
    
    // 🚩 プレイヤー本人のデータにフラグを立てる
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.hasFinishedLikeCheck = true;

    if (!room.finishedLikeCheckers) room.finishedLikeCheckers = new Set();
    room.finishedLikeCheckers.add(socket.id);

    // 「終わったから次へ進めて」と依頼するだけ
    advanceAfterLikeCheck(room, roomId);
});
    
socket.on('requestRoomState', () => {
const { roomId } = socket.data;
    const room = rooms[roomId];
if (!room) {
        console.log("❌ ルームが見つかりません");
        return;
    }

    // 👈 2. room が定義された後に、currentVote の中身があるかチェックしてログを出す
    if (room.currentVote && room.currentVote.votes) {
        console.log(`投票状況: ${Object.keys(room.currentVote.votes).length} / ${room.currentVote.voters.length}`);
    }

    // 🚩 0. まず現在のフェーズを叩き込む（playing か result かをハッキリさせる）
    socket.emit('phaseUpdated', room.phase);
    
    // 🚩 同期要求が来たついでに、評価や投票が「終わるべき状態」かチェックする
    if (room.currentRating) {
//        ★5評価
        checkRatingComplete(room, roomId); // 👈 これで人数チェックして、足りてれば completeRating が走る
    }
    if (room.currentVote) {
//        投票
       checkVoteComplete(room, roomId); // 👈 これで人数チェックして、足りてれば checkVoteCompleteが走る
        // 🚩 同期用に「最新の votes（誰が投票したか）」を含めて送る
        // これがないと、クライアント側で「投票済み」判定ができません
        socket.emit('startVote', {
            ...room.currentVote,
            totalVoters: room.players.length - 1 // 自分以外の人数
        });
    } else {
        socket.emit('startVote', null);
    }

    // その後、最新の room.field や room.deck を送る
    socket.emit('updateField', room.field);
    socket.emit('roomState', getRoomState(roomId));
    
// 2. ターンの同期
    const isActualTurnMode = room.options && room.options.turnBased === true;
    const currentPlayer = room.players[room.turnIndex];

    if (isActualTurnMode && currentPlayer) {
        // 【ターン制が有効な場合】
        // 通常通り、現在のターン情報を送る
        socket.emit('turnUpdate', {
            turnIndex: room.turnIndex,
            currentPlayerId: currentPlayer.id,
            currentPlayerName: currentPlayer.name
        });
    } else {
        // 【ターン制が無効、またはプレイヤーがいない場合】
        // 明示的に null を送り、クライアント側の「あなたのターン」表示や光る演出を消させる
        socket.emit('turnUpdate', {
            turnIndex: -1,
            currentPlayerId: null,
            currentPlayerName: null
        });
    }

    // 3. 進行中の「投票」があれば再送、なければ「null」を送りつけて強制終了させる
    if (room.currentVote) {
        socket.emit('startVote', room.currentVote);
        const votedCount = Object.keys(room.currentVote.votes).length;
        const totalVoters = room.currentVote.voters.length;
        socket.emit('voteUpdate', { votedCount, totalVoters });
    } else {
        // 🚩 ここが重要：進行中の投票がないなら、クライアントの「投票中フラグ」を確実に折る
        socket.emit('startVote', null);
    }

    // 4. 星評価も同様
    if (room.currentRating) {
        socket.emit('startRate', room.currentRating);
    } else {
        socket.emit('startRate', null);
    }
    
// --- 🚩 5. 【修正】リザルト・採点画面の同期ロジック ---
// ended（終了済み）も含める
if ((room.phase === 'rating' || room.phase === 'result' || room.phase === 'ended') && room.options.score100) {
    const totalPlayers = room.players.length;
    const votedCount = room.gameRatings ? Object.keys(room.gameRatings).length : 0;

    // 現在のフェーズを伝える
    socket.emit('phaseUpdated', room.phase);
    
    if (votedCount < totalPlayers && room.phase !== 'ended') {
        // 【採点中の場合】
        socket.emit('startFinalRating', { totalPlayers: totalPlayers });
        socket.emit('gameScoreUpdate', { 
            votedCount: votedCount, 
            totalPlayers: totalPlayers 
        });
    } else {
        // 【全員終わっている、または phase が ended の場合】
        // 🚩 同期した本人にリザルトデータを送る
        if (room.lastResultData) {
            // 保存済みのデータがあればそれを送る
            socket.emit('resultData', room.lastResultData);
        } else {
            // なければその場で作って送る（念のため）
            showFinalResult(room, socket.id);
        }
    }


    
        // 集計データを本人(socket.id)だけに再送して、リザルト画面を描画させる
//        showFinalResult(room, socket.id);
    }

// getRoomState(roomId) は、既に mode, phase, deckCount, players を含んでいます
    const fullState = getRoomState(roomId);
    
    // もし prevLast など、getRoomState に入っていない追加情報があればここで合成
    fullState.prevLast = room.prevLast;
    fullState.textDeck = room.textDeck;

    socket.emit('roomState', fullState);
});

socket.on('message', (data) => {
    const { roomId } = socket.data;
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const name = player ? player.name : "不明";
    const color = player ? player.color : "#000";
    
    const msgObj = { 
        text: `${name}: ${data.text}`, 
        color: color 
    };

    // 全員に「名前：メッセージ」の形で送る
//    io.to(roomId).emit('message', {
//        text: `${name}: ${data.text}`,
//        color: color
//    });
    
    // 🚩 履歴に追加（最新の100件を保持）
room.messages.push(msgObj);
    if (room.messages.length > 100) room.messages.shift();
    
    io.to(roomId).emit('message', msgObj);
});
    
    
}); // <--- 🟢 io.on('connection') の閉じ

const PORT = 3000;
// '0.0.0.0' を明示的に指定して、全ての入口を開放する
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 http://192.168.10.103:${PORT} でサーバー起動中`);
});