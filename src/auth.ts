/* 소셜 로그인 — 카카오 · 네이버 · 구글.

   셋 다 OAuth 2.0 authorization code 흐름이라 골격이 같다. 다른 건 주소와
   프로필 응답 모양뿐이라 PROVIDERS 표에 그것만 적어두고 나머지는 공유한다.

   자격 증명은 환경 변수로 받는다. 각 개발자 콘솔에서 앱을 등록하고
   리다이렉트 URI를 <BASE_URL>/auth/<provider>/callback 으로 넣어야 한다. */
import { randomBytes, createHash, timingSafeEqual, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { db, upsertUser, getUser, newId, type User } from "./db.ts";

export const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const SESSION_DAYS = 30;

type Profile = { uid: string; email: string | null; name: string | null; avatar: string | null };

type Provider = {
  id: string;
  label: string;
  color: string;
  fg: string;
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
  /** 토큰 요청에 client_secret이 필요한가 (카카오는 선택) */
  needsSecret: boolean;
  profile(json: any): Profile;
};

export const PROVIDERS: Record<string, Provider> = {
  kakao: {
    id: "kakao", label: "카카오로 계속하기", color: "#FEE500", fg: "#191600",
    authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    // 로그인에 필요한 건 고유 ID 하나뿐이다. 닉네임·사진·이메일은 받지 않는다.
    // 표시용으로 원하면 KAKAO_SCOPE="profile_nickname profile_image" 로 켤 수 있다.
    scope: "",
    needsSecret: false,
    profile: (j) => ({
      uid: String(j.id),
      email: j.kakao_account?.email ?? null,
      name: j.kakao_account?.profile?.nickname ?? j.properties?.nickname ?? null,
      avatar: j.kakao_account?.profile?.profile_image_url ?? j.properties?.profile_image ?? null,
    }),
  },
  naver: {
    id: "naver", label: "네이버로 계속하기", color: "#03C75A", fg: "#FFFFFF",
    authorizeUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    needsSecret: true,
    profile: (j) => ({
      uid: String(j.response?.id ?? ""),
      email: j.response?.email ?? null,
      name: j.response?.nickname ?? j.response?.name ?? null,
      avatar: j.response?.profile_image ?? null,
    }),
  },
  google: {
    id: "google", label: "Google로 계속하기", color: "#FFFFFF", fg: "#1F1F1F",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // openid 만 있으면 sub(고유 ID)를 받는다. 이름·이메일은 요청하지 않는다.
    scope: "openid",
    needsSecret: true,
    profile: (j) => ({
      uid: String(j.sub),
      email: j.email ?? null,
      name: j.name ?? null,
      avatar: j.picture ?? null,
    }),
  },
};

const env = (p: string, k: string) => process.env[`${p.toUpperCase()}_${k}`] ?? "";
const clientId = (p: string) => env(p, "CLIENT_ID");
const clientSecret = (p: string) => env(p, "CLIENT_SECRET");

/** 자격 증명이 채워진 제공자. **화면에 보일 것과는 다르다** — 아래를 보라. */
export const configuredProviders = (): { id: string; label: string; color: string; fg: string }[] =>
  Object.values(PROVIDERS)
    .filter(p => clientId(p.id) && (!p.needsSecret || clientSecret(p.id)))
    .map(p => ({ id: p.id, label: p.label, color: p.color, fg: p.fg }));

/* **잠시 꺼 두는 길.** DISABLED_LOGINS="kakao" 처럼 적으면 그 버튼이 사라지고
   그 길로 들어오는 요청도 막힌다.

   자격 증명은 .env 에 그대로 둔다 — 지워서 끄면 안 되는 까닭이 있다.
   localFallbackAllowed() 가 "제공자가 하나도 없으면 로컬 계정으로 연다" 인데,
   키를 지워 0이 되면 로그인 없이 들어온 사람들이 **같은 계정 하나**를 나눠 쓰게 된다
   (provider_uid 가 "local" 로 고정이라 줄이 하나뿐이다). 끄는 것과 지우는 것은 다르다. */
const disabledLogins = (): Set<string> =>
  new Set((process.env.DISABLED_LOGINS ?? "").split(",").map(s => s.trim()).filter(Boolean));

/** 지금 로그인 화면에 세울 것 — 설정되어 있고, 꺼 두지 않은 것. */
export const availableProviders = (): { id: string; label: string; color: string; fg: string }[] => {
  const off = disabledLogins();
  return configuredProviders().filter(p => !off.has(p.id));
};

/** 그 길이 지금 열려 있나 — 화면을 안 거치고 주소로 바로 들어오는 경우를 막는다. */
export const loginOpen = (id: string): boolean => !disabledLogins().has(id);

export const redirectUri = (p: string) => `${BASE_URL}/auth/${p}/callback`;

/* ── 로그인 시작 ─────────────────────────────────────────── */
export function startLogin(providerId: string): string | null {
  const p = PROVIDERS[providerId];
  if (!p || !clientId(providerId)) return null;
  if (!loginOpen(providerId)) return null;      // 버튼만 감추면 주소로 들어올 수 있다

  // state는 서버가 기억한다 — 돌아온 요청이 우리가 보낸 것인지 확인하는 용도(CSRF)
  const state = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO oauth_state(state, provider, verifier, created_at) VALUES(?,?,?,?)")
    .run(state, providerId, null, Date.now());
  db.prepare("DELETE FROM oauth_state WHERE created_at < ?").run(Date.now() - 10 * 60_000);

  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId(providerId),
    redirect_uri: redirectUri(providerId),
    state,
  });
  // 승인되지 않은 동의항목을 요청하면 로그인 자체가 실패하므로 밖에서 바꿀 수 있게 둔다.
  // 변수를 빈 값으로 두면 "아무것도 요청하지 않음"이 되어야 하니 존재 여부로 가른다.
  const key = `${providerId.toUpperCase()}_SCOPE`;
  const scope = key in process.env ? String(process.env[key]) : p.scope;
  if (scope) q.set("scope", scope);
  return `${p.authorizeUrl}?${q}`;
}

/* ── 콜백 처리 ───────────────────────────────────────────── */
export type Account = {
  provider: string; providerUid: string;
  email: string | null; name: string | null; avatar: string | null;
};

export async function completeLogin(
  providerId: string, code: string, state: string,
): Promise<{ ok: true; user: User; account: Account } | { ok: false; reason: string }> {
  const p = PROVIDERS[providerId];
  if (!p) return { ok: false, reason: "알 수 없는 로그인 방식입니다." };

  const row = db.prepare("SELECT provider FROM oauth_state WHERE state = ?").get(state) as
    { provider: string } | undefined;
  db.prepare("DELETE FROM oauth_state WHERE state = ?").run(state);
  if (!row || row.provider !== providerId)
    return { ok: false, reason: "로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요." };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId(providerId),
    redirect_uri: redirectUri(providerId),
    code, state,
  });
  if (clientSecret(providerId)) body.set("client_secret", clientSecret(providerId));

  let token: any;
  try {
    const res = await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    token = await res.json();
  } catch {
    return { ok: false, reason: "로그인 서버에 연결하지 못했습니다." };
  }
  if (!token?.access_token) {
    // 제공자가 주는 코드는 짧아서 원인을 알기 어렵다 — 설명과 흔한 원인을 같이 보여준다.
    const code = String(token?.error ?? "unknown");
    const desc = token?.error_description ? ` — ${token.error_description}` : "";
    const hint = code === "invalid_client" && !clientSecret(providerId)
      ? `
${p.label.replace("로 계속하기", "")} 콘솔에서 Client Secret이 켜져 있는 것 같습니다. `
        + `${providerId.toUpperCase()}_CLIENT_SECRET 을 .env에 넣어 주세요.`
      : "";
    return { ok: false, reason: `토큰을 받지 못했습니다 (${code})${desc}${hint}` };
  }

  let profile: any;
  try {
    const res = await fetch(p.profileUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    profile = await res.json();
  } catch {
    return { ok: false, reason: "프로필을 가져오지 못했습니다." };
  }

  const info = p.profile(profile);
  if (!info.uid) return { ok: false, reason: "계정 식별자를 받지 못했습니다." };
  /* 게스트가 로그인하는 경우에는 새 계정을 만드는 대신 쓰던 계정에 이어 붙여야 한다.
     그 판단은 세션을 아는 쪽(server.ts)이 하므로, 여기서는 받아온 프로필을 함께 넘긴다. */
  const account = { provider: providerId, providerUid: info.uid, ...info };
  return { ok: true, user: upsertUser(account), account };
}

/* ── 비밀번호 ─────────────────────────────────────────────
   그대로 담지 않고 scrypt 로 요약해서 담는다. 소금(salt)은 계정마다 다르게 뽑으므로
   같은 비밀번호를 쓴 두 사람의 요약이 같아지지 않는다.

   scrypt 는 일부러 느리고 메모리를 많이 쓰는 셈법이다 — 빠른 셈법(SHA 같은 것)으로
   요약하면 훔쳐간 사람이 초당 수십억 번씩 맞춰볼 수 있다. */
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SCRYPT_LEN = 64;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT_LEN);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

/** 맞는지 본다. 어떤 값이 와도 같은 시간이 들도록 timingSafeEqual 로 견준다. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, saltB64, keyB64] = stored.split(":");
  if (kind !== "scrypt" || !saltB64 || !keyB64) return false;
  const want = Buffer.from(keyB64, "base64url");
  const got = await scryptAsync(pw, Buffer.from(saltB64, "base64url"), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** 아이디로 쓸 수 있는 값인가 — 영문·숫자·밑줄 3~20자 */
export const validLoginId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_]{3,20}$/.test(v);

/** 비밀번호는 8자 이상. 짧은 것을 막는 것만으로도 대부분을 거른다. */
export const validPassword = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 8 && v.length <= 200;

/* ── 세션 ────────────────────────────────────────────────── */
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function createSession(userId: string, ua: string | null): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO session(token_hash, user_id, created_at, expires_at, ua) VALUES(?,?,?,?,?)")
    .run(hash(token), userId, now, now + SESSION_DAYS * 864e5, ua?.slice(0, 200) ?? null);
  db.prepare("DELETE FROM session WHERE expires_at < ?").run(now);
  return token;
}

export function userFromToken(token: string | null): User | null {
  if (!token) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM session WHERE token_hash = ?")
    .get(hash(token)) as { user_id: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM session WHERE token_hash = ?").run(hash(token));
    return null;
  }
  // 열이 늘어날 때마다 여기서 빠뜨리기 쉬우므로 db의 변환 함수를 그대로 쓴다
  return getUser(row.user_id);
}

export const destroySession = (token: string | null): void => {
  if (token) db.prepare("DELETE FROM session WHERE token_hash = ?").run(hash(token));
};

/* ── 공유 열쇠 ────────────────────────────────────────────
   브라우저 밖에서 오는 길(iOS 단축어·TWA)의 신분증. 세션과 **나란히** 두되 섞지 않는다 —
   왜 따로인지는 db.ts 의 share_key 표에 적어 두었다. 여기서는 만들고, 알아보고, 지운다.

   **앞에 hhk_ 를 붙인다.** 열쇠가 여기저기 적혀 다니다 보면 어느 것이 무엇인지 헷갈리는데,
   그때 눈으로 가릴 수 있어야 한다. 알아보는 쪽도 이 표만 보므로 세션 쿠키를 여기에
   넣어 봐야 통하지 않고, 그 반대도 마찬가지다. */
export function createShareKey(userId: string, label: string): { id: string; token: string } {
  const token = "hhk_" + randomBytes(24).toString("base64url");
  const id = randomBytes(8).toString("base64url");
  db.prepare("INSERT INTO share_key(id, user_id, token_hash, label, created_at) VALUES(?,?,?,?,?)")
    .run(id, userId, hash(token), label.trim().slice(0, 40) || "이름 없는 기기", Date.now());
  return { id, token };
}

/** 열쇠를 든 사람. **쓴 때를 적는다** — 어느 열쇠가 살아 있는지 화면에서 가리려면 필요하다. */
export function shareKeyUser(token: string | null): User | null {
  if (!token) return null;
  const row = db.prepare("SELECT id, user_id FROM share_key WHERE token_hash = ?")
    .get(hash(token)) as { id: string; user_id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE share_key SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return getUser(row.user_id);
}

export const listShareKeys = (userId: string): ShareKey[] =>
  db.prepare(`SELECT id, label, created_at AS createdAt, used_at AS usedAt
              FROM share_key WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as ShareKey[];

/** 남의 열쇠를 지우지 못하도록 user_id 를 함께 짚는다 — id 만으로 지우면 남의 것도 지워진다. */
export const deleteShareKey = (userId: string, id: string): boolean =>
  db.prepare("DELETE FROM share_key WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;

export type ShareKey = { id: string; label: string; createdAt: number; usedAt: number | null };

export const COOKIE = "hh_session";

export function cookieHeader(token: string, maxAgeSec: number): string {
  const secure = BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** 자격 증명이 하나도 없으면 로그인 자체가 불가능하다 — 그때만 로컬 계정을 허용한다. */
export const localFallbackAllowed = (): boolean => configuredProviders().length === 0;
