// ===============================
// モード定義
// ===============================
const MODE_RULES = {
  illustrory: {
    label: 'イラストリー',
    state: {
      turnBased: { checked: true,  disabled: true },
      shiritori: { checked: true,  disabled: true },
      vote:      { checked: true,  disabled: true },
      star5:     { checked: false, disabled: false },
      like:      { checked: false, disabled: false },
      score100:  { checked: false, disabled: false },
    },
    deck: 'image'
  },

  story: {
    label: 'ストーリー',
    state: {
      turnBased: { checked: false, disabled: true },
      shiritori: { checked: false, disabled: true },
      vote:      { checked: false, disabled: true },
      star5:     { checked: true,  disabled: false },
      like:      { checked: false, disabled: false },
      score100:  { checked: true,  disabled: false },
    },
    deck: 'image_or_word'
  },

  word: {
    label: 'ワード',
    state: {
      turnBased: { checked: false, disabled: true },
      shiritori: { checked: false, disabled: true },
      vote:      { checked: false, disabled: true },
      star5:     { checked: false, disabled: false },
      like:      { checked: true,  disabled: false },
      score100:  { checked: true,  disabled: false },
    },
    deck: 'none'
  }
};

// ===============================
// checkbox utilities
// ===============================
const checkboxes = [
  ...document.querySelectorAll('#options input[type="checkbox"]')
];

function getCheckbox(key) {
  return checkboxes.find(cb => cb.dataset.option === key);
}

// 次のゲーム情報
const modeSelect = document.getElementById('modeSelect');
let pendingMode = modeSelect.value;
let pendingOptions = {};
// プルダウン変更時は内部変数のみ更新
modeSelect.addEventListener('change', e => {
  pendingMode = e.target.value;
  const rules = MODE_RULES[pendingMode];
  pendingOptions = {};
  Object.entries(rules.state).forEach(([key, state]) => {
    pendingOptions[key] = state.checked;
  });
  // UIには一切反映しない
});

toggleShiritoriInput(pendingMode);

// プルダウン選択時用（UI確認用）
function applyPendingModeRules(mode) {
  const rules = MODE_RULES[mode];
  if (!rules) return;
  // チェックボックス確認用UIだけ更新
  checkboxes.forEach(cb => { cb.checked = false; cb.disabled = false; });
  Object.entries(rules.state).forEach(([key, state]) => {
    const cb = getCheckbox(key);
    if (!cb) return;
    cb.checked = state.checked;
    cb.disabled = state.disabled;
  });
}
    // しりとり入力欄の表示切替
function toggleShiritoriInput(mode) {
  const area = document.getElementById('illustroryTextArea');
  area.style.display = (mode === 'illustrory') ? 'block' : 'none';
  if (mode !== 'illustrory') document.getElementById('illustroryText').value = '';
}



document.getElementById('startGameBtn').addEventListener('click', () => {
      // デバッグ：スタート直前のプルダウン状態を確認
  console.log('スタート押下直前 disabled:', modeSelect.disabled);
    
  // pendingMode / pendingOptions を現在のゲームに反映
  currentGameMode = pendingMode;
  currentGameOptions = { ...pendingOptions };
  
  updateModeDisplay(currentGameMode);      // この時に初めて上部表示も変更
  toggleShiritoriInput(currentGameMode);   // 入力欄の表示切替
  applyDeckMode(MODE_RULES[currentGameMode].deck); // デッキUIも反映

      // デバッグ：スタート押下後のプルダウン状態を確認
  console.log('スタート押下後 disabled:', modeSelect.disabled);
    
  // サーバに送信してゲーム開始
  socket.emit('updateSettings', { mode: currentGameMode, options: currentGameOptions });
  socket.emit('startGame');
});


// ===============================
// 初期適用 + プルダウン連動
// ===============================

applyPendingModeRules(modeSelect.value);
pendingMode = modeSelect.value;
const rules = MODE_RULES[pendingMode];
pendingOptions = {};
Object.entries(rules.state).forEach(([key, state]) => {
  pendingOptions[key] = state.checked;
});

toggleShiritoriInput(pendingMode);
applyDeckMode(MODE_RULES[pendingMode].deck);
updateModeDisplay(pendingMode);


// デッキ登録UI切替
function applyDeckMode(deckType) {
  const upload = document.getElementById('deckUpload');
  const words  = document.getElementById('deckWords');

  if (deckType === 'image') {
    upload.style.display = 'block';
    words.style.display = 'none';
  } else if (deckType === 'image_or_word') {
    upload.style.display = 'block';
    words.style.display = 'block';
  } else { // 'none'
    upload.style.display = 'none';
    words.style.display = 'none';
  }
}


// デッキ登録ボタン処理
document.getElementById('registerDeckBtn').addEventListener('click', () => {
  const mode = modeSelect.value;
  const deckType = MODE_RULES[mode].deck;

  if (deckType === 'image') {
    const files = document.getElementById('deckUpload').files;
    if (!files.length) return alert('画像を選択してください');
    // ここでサーバにアップロード処理を追加
    console.log('画像デッキ登録:', files);
  } else if (deckType === 'image_or_word') {
    const files = document.getElementById('deckUpload').files;
    const words = document.getElementById('deckWords').value
                  .split('\n').map(s => s.trim()).filter(Boolean);
    if (!files.length && !words.length) return alert('画像かワードを登録してください');
    // サーバに送信する処理をここに追加
    console.log('画像:', files, 'ワード:', words);
  } else {
    alert('このモードではデッキ登録はできません');
  }
});




