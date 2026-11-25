const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://localhost:8080";
const TEST_USER = process.env.TEST_USER || `e2e_user_${Date.now()}`;
const TEST_PASS = process.env.TEST_PASS || "E2ePass123!";
const TOPUP_AMOUNT = Number(process.env.TOPUP_AMOUNT || 100000);
const BET_AMOUNT = Number(process.env.BET_AMOUNT || 10000);
const CHAT_TEXT = process.env.CHAT_TEXT || `E2E تست ${Date.now()}`;

function runE2ETest() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let step = "init";
    let balanceAfterTopup = null;
    let slotsResult = null;
    let slotsSynced = false;
    let chatMatched = false;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out at E2E step "${step}"`));
    }, 15000);

    ws.on("open", () => {
      console.log("[E2E] Connected to", WS_URL);
      step = "register";
      console.log(`[E2E] [1/4] Registering user "${TEST_USER}"...`);
      ws.send(
        JSON.stringify({
          type: "REGISTER_USER",
          username: TEST_USER,
          fullName: "کاربر تست سرتاسری",
          phone: "09121112233",
          email: `${TEST_USER}@example.com`,
          password: TEST_PASS
        })
      );
    });

    function checkAllDone() {
      if (balanceAfterTopup !== null && slotsResult && slotsSynced && chatMatched) {
        clearTimeout(timer);
        ws.close();
        resolve({
          username: TEST_USER,
          balanceAfterTopup,
          slotsResult,
          chatText: CHAT_TEXT
        });
      }
    }

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "AUTH_ERROR") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`Auth failed during ${step}: ${msg.message}`));
        return;
      }

      if (msg.type === "TOAST" && (step === "topup" || step === "play_slots" || step === "send_chat")) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`Server TOAST during ${step}: ${msg.message}`));
        return;
      }

      if (msg.type === "AUTH_SUCCESS" && step === "register") {
        step = "topup";
        console.log(`[E2E] [2/4] Registered. Sending TOPUP_DEMO (${TOPUP_AMOUNT})...`);
        ws.send(
          JSON.stringify({
            type: "TOPUP_DEMO",
            username: TEST_USER,
            amount: TOPUP_AMOUNT
          })
        );
        return;
      }

      if (msg.type === "WALLET_SYNC" && msg.wallet?.username === TEST_USER) {
        const demoBal = Number(msg.wallet.demo ?? 0);
        const latestTx = Array.isArray(msg.txs) ? msg.txs[0] : null;
        console.log(
          `[E2E] WALLET_SYNC | step=${step} | demo=${demoBal} | tx=${latestTx?.type || "-"} (${latestTx?.amount ?? "-"})`
        );

        if (step === "topup" && demoBal >= TOPUP_AMOUNT) {
          balanceAfterTopup = demoBal;
          step = "play_slots";
          console.log(`[E2E] [3/4] Wallet topped up (${demoBal}). Playing SLOTS (bet=${BET_AMOUNT})...`);
          ws.send(
            JSON.stringify({
              type: "PLAY_SLOTS",
              username: TEST_USER,
              mode: "demo",
              bet: BET_AMOUNT
            })
          );
          return;
        }

        if (step === "play_slots" && latestTx?.type === "اسلات") {
          slotsSynced = true;
          step = "send_chat";
          console.log(`[E2E] [4/4] Slots wallet synced (demo=${demoBal}). Sending CHAT_SEND...`);
          ws.send(
            JSON.stringify({
              type: "CHAT_SEND",
              username: TEST_USER,
              text: CHAT_TEXT
            })
          );
          checkAllDone();
        }
        return;
      }

      if (msg.type === "SLOTS_RESULT" && step === "play_slots") {
        slotsResult = msg;
        console.log(
          `[E2E] SLOTS_RESULT | reels=${JSON.stringify(msg.reels)}, won=${msg.won}, payout=${msg.payout}`
        );
        checkAllDone();
        return;
      }

      if (msg.type === "CHAT_SYNC" && step === "send_chat") {
        const messages = Array.isArray(msg.chat?.messages) ? msg.chat.messages : [];
        const found = messages.find((m) => m.user === TEST_USER && m.text === CHAT_TEXT && !m.deleted);
        if (found) {
          chatMatched = true;
          console.log(`[E2E] CHAT_SYNC verified message id=${found.id}`);
          checkAllDone();
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

runE2ETest()
  .then((summary) => {
    console.log(
      `\nE2E flow passed for "${summary.username}": topup=${summary.balanceAfterTopup}, slotsWon=${summary.slotsResult.won} (payout=${summary.slotsResult.payout}), chat="${summary.chatText}"`
    );
  })
  .catch((err) => {
    console.error("\nE2E flow failed:", err.message);
    process.exit(1);
  });
