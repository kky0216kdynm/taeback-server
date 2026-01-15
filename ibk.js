const express = require("express");

const router = express.Router();

const IBK_CLIENT_ID = process.env.IBK_CLIENT_ID;
const IBK_CLIENT_SECRET = process.env.IBK_CLIENT_SECRET;
const IBK_REDIRECT_URI =
  process.env.IBK_REDIRECT_URI || "https://api.taeback.net/ibk/callback";

// ✅ 포털 문서에서 확인해서 채우기
const IBK_AUTH_URL = process.env.IBK_AUTH_URL; // 예: https://.../oauth/authorize
const IBK_TOKEN_URL = process.env.IBK_TOKEN_URL; // 예: https://.../oauth/token

// Node 20+ 내장 fetch 사용
const fetchFn = globalThis.fetch;

// (간단 저장: 운영은 DB/Redis 권장)
let tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null,
};

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
}

function requireFetch() {
  if (typeof fetchFn !== "function") {
    throw new Error(
      "fetch is not available. Use Node 18+ (this project uses Node 20) or install a fetch polyfill."
    );
  }
}

// 1) 인증 시작(브라우저에서 호출)
router.get("/auth", (req, res) => {
  try {
    requireEnv("IBK_CLIENT_ID", IBK_CLIENT_ID);
    requireEnv("IBK_CLIENT_SECRET", IBK_CLIENT_SECRET);
    requireEnv("IBK_AUTH_URL", IBK_AUTH_URL);
    requireEnv("IBK_TOKEN_URL", IBK_TOKEN_URL);

    const state = String(Date.now()); // 운영: 랜덤 + 세션 저장 권장
    const scope = process.env.IBK_SCOPE || ""; // 문서에 scope 있으면 설정

    const url = new URL(IBK_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", IBK_CLIENT_ID);
    url.searchParams.set("redirect_uri", IBK_REDIRECT_URI);
    if (scope) url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);

    return res.redirect(url.toString());
  } catch (e) {
    return res.status(500).send(`IBK auth init failed: ${e.message}`);
  }
});

// 2) 콜백: code → 토큰 교환
router.get("/callback", async (req, res) => {
  try {
    requireFetch();

    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    // 문서에 맞게 grant_type / 헤더/바디 형식 조정 필요
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", IBK_REDIRECT_URI);
    body.set("client_id", IBK_CLIENT_ID);
    body.set("client_secret", IBK_CLIENT_SECRET);

    const r = await fetchFn(IBK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(502).send(`Token exchange failed (${r.status}): ${text}`);
    }

    const json = JSON.parse(text);

    tokenStore.access_token = json.access_token;
    tokenStore.refresh_token = json.refresh_token || null;
    tokenStore.expires_at = json.expires_in ? Date.now() + json.expires_in * 1000 : null;

    return res.send("✅ IBK 인증 완료. 토큰 저장됨(서버).");
  } catch (e) {
    return res.status(500).send(`Callback failed: ${e.message}`);
  }
});

// 3) 토큰 상태 확인(디버그)
router.get("/token", (req, res) => {
  res.json({
    has_access_token: !!tokenStore.access_token,
    expires_at: tokenStore.expires_at,
  });
});

module.exports = router;
