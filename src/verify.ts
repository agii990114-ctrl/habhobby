/* 이메일 인증 — 6자리 코드를 만들고, 맞는지 보고, 인증을 마쳤다는 티켓을 낸다.

   가입과 비밀번호 재설정이 같은 길을 쓴다(목적 purpose 만 다르다). 보안이 이 파일의 일이다:

   · **코드는 진짜 난수**다(randomInt). 원문은 어디에도 남기지 않고 HMAC 만 담는다.
   · **짧게 살고 한 번만 쓰인다.** 10분, 틀리면 5번까지. 다시 받으면 이전 코드는 죽는다.
   · **티켓이 있어야 다음 걸음**(새 비밀번호)으로 간다. 티켓은 코드를 맞힌 사람만 받고, 목적이 같은
     자리에서만 쓰이며, 한 번 쓰면 사라진다.
   · **없는 계정도 똑같이 군다.** 코드를 만들어 줄은 남기되 메일만 안 보낸다(미끼) — 그러지 않으면
     「코드 없음」과 「코드 틀림」의 차이로 가입 여부를 알아낸다.
   · **한도가 셋이다** — 메일 주소당, IP 당, 하루 전체. 남의 메일함을 폭격하거나 발송 한도를 태우는
     일을 막는다. 맞히기 시도는 IP 당 따로 센다. */
import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";

export type Purpose = "signup" | "reset";

export const CODE_TTL = 10 * 60_000;
export const TICKET_TTL = 15 * 60_000;
export const RESEND_COOLDOWN = 60_000;
const MAX_TRIES = 5;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const PER_EMAIL_HOUR = 5, PER_IP_HOUR = 10, ALL_PER_DAY = 300, FAILS_PER_IP_HOUR = 20;

/** 코드를 요약하는 비밀 열쇠. 처음 부를 때 뽑아 DB 에 둔다 — 환경 변수를 하나 더 챙기게 하지 않는다. */
let KEY: Buffer | null = null;
function secret(): Buffer {
  if (KEY) return KEY;
  db.prepare("INSERT OR IGNORE INTO app_secret(name, value) VALUES('code_mac', ?)")
    .run(randomBytes(32).toString("hex"));
  const r = db.prepare("SELECT value FROM app_secret WHERE name = 'code_mac'").get() as { value: string };
  return (KEY = Buffer.from(r.value, "hex"));
}
const mac = (purpose: Purpose, email: string, code: string): string =>
  createHmac("sha256", secret()).update(`${purpose}\n${email}\n${code}`).digest("hex");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const count = (sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** 메일 부탁을 받아도 되는가. 되면 기록을 남기고 `ok`, 아니면 이유와 기다릴 초.
    **계정이 있든 없든 똑같이 센다** — 한도가 다르게 걸리면 그것으로 가입 여부를 안다. */
export function allowRequest(purpose: Purpose | "find", email: string, ip: string):
  { ok: true } | { ok: false; reason: string; wait: number } {
  const now = Date.now();
  db.prepare("DELETE FROM mail_log WHERE at < ?").run(now - DAY);
  if (count("SELECT COUNT(*) n FROM mail_log WHERE purpose <> 'vfail' AND at > ?", now - DAY) >= ALL_PER_DAY)
    return { ok: false, reason: "지금은 메일을 보낼 수 없습니다. 내일 다시 시도해 주세요.", wait: 3600 };
  if (count("SELECT COUNT(*) n FROM mail_log WHERE purpose <> 'vfail' AND ip = ? AND at > ?", ip, now - HOUR) >= PER_IP_HOUR)
    return { ok: false, reason: "요청이 너무 많습니다. 한 시간 뒤에 다시 해 주세요.", wait: 3600 };
  if (count("SELECT COUNT(*) n FROM mail_log WHERE purpose <> 'vfail' AND email = ? AND at > ?", email, now - HOUR) >= PER_EMAIL_HOUR)
    return { ok: false, reason: "이 메일 주소로는 잠시 더 보낼 수 없습니다. 한 시간 뒤에 다시 해 주세요.", wait: 3600 };
  if (purpose !== "find") {
    const row = db.prepare("SELECT created_at FROM email_code WHERE purpose = ? AND email = ?")
      .get(purpose, email) as { created_at: number } | undefined;
    if (row && now - row.created_at < RESEND_COOLDOWN) {
      const wait = Math.ceil((RESEND_COOLDOWN - (now - row.created_at)) / 1000);
      return { ok: false, reason: `${wait}초 뒤에 다시 받을 수 있습니다.`, wait };
    }
  }
  db.prepare("INSERT INTO mail_log(at, email, ip, purpose) VALUES(?,?,?,?)").run(now, email, ip, purpose);
  return { ok: true };
}

/** 코드를 새로 만든다. 이전 코드와 티켓은 그 자리에서 죽는다. **원문 코드를 돌려주는 것은 메일로 보내라는 뜻뿐이다.** */
export function issueCode(purpose: Purpose, email: string, loginId: string | null): string {
  const now = Date.now();
  db.prepare("DELETE FROM email_code WHERE expires_at < ? AND (ticket_expires IS NULL OR ticket_expires < ?)")
    .run(now, now);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(`INSERT OR REPLACE INTO email_code
      (purpose, email, login_id, code_mac, tries, created_at, expires_at, ticket_hash, ticket_expires)
    VALUES (?,?,?,?,0,?,?,NULL,NULL)`)
    .run(purpose, email, loginId, mac(purpose, email, code), now, now + CODE_TTL);
  return code;
}

/** 이 IP 가 코드를 너무 많이 틀렸는가 — 한 줄에 5번이라 해도 주소를 바꿔 가며 두드릴 수 있다 */
export const tooManyFails = (ip: string): boolean =>
  count("SELECT COUNT(*) n FROM mail_log WHERE purpose = 'vfail' AND ip = ? AND at > ?", ip, Date.now() - HOUR)
    >= FAILS_PER_IP_HOUR;
const recordFail = (ip: string) =>
  db.prepare("INSERT INTO mail_log(at, email, ip, purpose) VALUES(?,?,?,'vfail')").run(Date.now(), "", ip);

const NO_CODE = "코드가 없거나 만료되었습니다. 코드를 다시 받아 주세요.";

/** 코드를 본다. 맞으면 티켓을 내고 코드는 비운다(한 번만). 어떤 실패든 말은 같은 모양이다. */
export function verifyCode(purpose: Purpose, email: string, code: unknown, ip: string):
  { ok: true; ticket: string } | { ok: false; reason: string; left?: number } {
  if (tooManyFails(ip)) return { ok: false, reason: "시도가 너무 많습니다. 한 시간 뒤에 다시 해 주세요." };
  const now = Date.now();
  const row = db.prepare("SELECT * FROM email_code WHERE purpose = ? AND email = ?")
    .get(purpose, email) as any;
  const shaped = typeof code === "string" && /^[0-9]{6}$/.test(code);
  if (!row || !row.code_mac || row.expires_at < now || !shaped) {
    recordFail(ip);
    return { ok: false, reason: shaped ? NO_CODE : "6자리 숫자를 입력해 주세요." };
  }
  const want = Buffer.from(row.code_mac, "hex");
  const got = Buffer.from(mac(purpose, email, code as string), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    recordFail(ip);
    const tries = row.tries + 1;
    if (tries >= MAX_TRIES) {
      // 다섯 번 틀리면 이 코드는 죽는다 — 맞힐 때까지 두드리는 길을 닫는다
      db.prepare("DELETE FROM email_code WHERE purpose = ? AND email = ?").run(purpose, email);
      return { ok: false, reason: "코드를 너무 여러 번 틀렸습니다. 코드를 다시 받아 주세요." };
    }
    db.prepare("UPDATE email_code SET tries = ? WHERE purpose = ? AND email = ?").run(tries, purpose, email);
    return { ok: false, reason: "코드가 맞지 않습니다.", left: MAX_TRIES - tries };
  }
  const ticket = randomBytes(32).toString("base64url");
  db.prepare(`UPDATE email_code SET code_mac = '', ticket_hash = ?, ticket_expires = ?
    WHERE purpose = ? AND email = ?`).run(sha(ticket), now + TICKET_TTL, purpose, email);
  return { ok: true, ticket };
}

/** 티켓이 살아 있는가 — 쓰지는 않는다. 새 비밀번호가 규칙에 안 맞을 때 인증을 잃지 않게 먼저 본다. */
export function peekTicket(purpose: Purpose, ticket: unknown): { email: string; loginId: string | null } | null {
  if (typeof ticket !== "string" || ticket.length < 32 || ticket.length > 100) return null;
  const r = db.prepare(`SELECT email, login_id FROM email_code
    WHERE purpose = ? AND ticket_hash = ? AND ticket_expires > ?`).get(purpose, sha(ticket), Date.now()) as any;
  return r ? { email: r.email, loginId: r.login_id ?? null } : null;
}

/** 티켓을 **꺼내 쓴다** — 한 번뿐이다. 두 요청이 동시에 와도 하나만 성공한다(DELETE … RETURNING). */
export function consumeTicket(purpose: Purpose, ticket: unknown): { email: string; loginId: string | null } | null {
  if (typeof ticket !== "string" || ticket.length < 32 || ticket.length > 100) return null;
  const r = db.prepare(`DELETE FROM email_code
    WHERE purpose = ? AND ticket_hash = ? AND ticket_expires > ? RETURNING email, login_id`)
    .get(purpose, sha(ticket), Date.now()) as any;
  return r ? { email: r.email, loginId: r.login_id ?? null } : null;
}

/** 그 이메일의 살아 있는 코드·티켓을 모두 치운다 — 비밀번호를 바꾼 뒤 남은 증표가 없게 */
export const revokeCodes = (email: string): void => {
  db.prepare("DELETE FROM email_code WHERE email = ?").run(email);
};
