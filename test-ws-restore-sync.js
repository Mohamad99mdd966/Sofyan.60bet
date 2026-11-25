const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://localhost:8080";
const TEST_USER = process.env.TEST_USER || `restore_user_${Date.now()}`;
const TEST_PASS = process.env.TEST_PASS || "RestorePass123!";
const TOPUP_AMOUNT = Number(process.env.TOPUP_AMOUNT || 50000);
const CHAT_TEXT = process.env.CHAT_TEXT || `RestoreSync ${Date.now()}`;

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket connection timed out"));
    }, 8000);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function runRestoreSyncTest() {
  const ws1 = await openSocket(WS_URL);
  let walletSynced = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws1.close();
      reject(new Error("Timed out during initial state setup"));
    }, 10000);

    ws1.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "AUTH_ERROR" || msg.type === "TOAST") {
        clearTimeout(timer);
        ws1.close();
        reject(new Error(`Unexpected server message (${msg.type}): ${msg.message || ""}`));
        return;
      }

      if (msg.type === "AUTH_SUCCESS") {
        sendJson(ws1, {
          type: "TOPUP_DEMO",
          username: TEST_USER,
          amount: TOPUP_AMOUNT
        });
        return;
      }

      if (msg.type === "WALLET_SYNC" && msg.wallet?.username === TEST_USER) {
        if (Number(msg.wallet.demo ?? 0) >= TOPUP_AMOUNT && !walletSynced) {
          walletSynced = true;
          sendJson(ws1, {
            type: "CHAT_SEND",
            username: TEST_USER,
            text: CHAT_TEXT
          });
        }
        return;
      }

      if (msg.type === "CHAT_SYNC" && walletSynced) {
        const messages = Array.isArray(msg.chat?.messages) ? msg.chat.messages : [];
        const found = messages.find((m) => m.user === TEST_USER && m.text === CHAT_TEXT && !m.deleted);
        if (found) {
          clearTimeout(timer);
          ws1.close();
          resolve();
        }
      }
    });

    sendJson(ws1, {
      type: "REGISTER_USER",
      username: TEST_USER,
      fullName: "کاربر تست بازیابی",
      phone: "09123334455",
      email: `${TEST_USER}@example.com`,
      password: TEST_PASS
    });
  });

  const ws2 = await openSocket(WS_URL);
  let verifiedWallet = null;
  let verifiedChat = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws2.close();
      reject(new Error("Timed out verifying restored WALLET_SYNC / CHAT_SYNC"));
    }, 10000);

    ws2.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "AUTH_ERROR") {
        clearTimeout(timer);
        ws2.close();
        reject(new Error(`Login failed on reconnect: ${msg.message}`));
        return;
      }

      if (msg.type === "AUTH_SUCCESS") {
        sendJson(ws2, {
          type: "WALLET_SYNC",
          username: TEST_USER
        });
        return;
      }

      if (msg.type === "WALLET_SYNC" && msg.wallet?.username === TEST_USER) {
        const demoBal = Number(msg.wallet.demo ?? 0);
        if (demoBal >= TOPUP_AMOUNT) {
          verifiedWallet = demoBal;
          if (verifiedChat) {
            clearTimeout(timer);
            ws2.close();
            resolve();
          }
        }
        return;
      }

      if (msg.type === "CHAT_SYNC") {
        const messages = Array.isArray(msg.chat?.messages) ? msg.chat.messages : [];
        const found = messages.find((m) => m.user === TEST_USER && m.text === CHAT_TEXT && !m.deleted);
        if (found) {
          verifiedChat = true;
          if (verifiedWallet !== null) {
            clearTimeout(timer);
            ws2.close();
            resolve();
          }
        }
      }
    });

    sendJson(ws2, {
      type: "LOGIN_USER",
      username: TEST_USER,
      password: TEST_PASS
    });
  });

  console.log(
    `Restore & WebSocket sync verified for "${TEST_USER}": demo=${verifiedWallet}, chat="${CHAT_TEXT}"`
  );
}

runRestoreSyncTest().catch((err) => {
  console.error("Restore sync test failed:", err.message);
  process.exit(1);
});
