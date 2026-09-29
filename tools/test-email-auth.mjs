// 이메일 인증 시험 — 가입 · 재설정 · 아이디 찾기의 보안 규칙을 새 DB 위에서 두드린다.
//
//   node --no-warnings tools/test-email-auth.mjs <프로젝트 루트> <임시 폴더>
//   예) node --no-warnings tools/test-email-auth.mjs . /tmp/hh-test
//
// 가짜 SMTP 서버(127.0.0.1:2525)를 곁에 세우고, 서버 두 대(메일 켬 8093 · 꺼 둠 8092)를 임시 폴더의
// **새 DB** 로 띄운다. 운영 DB 는 건드리지 않는다(DATA_DIR). 실패가 있으면 종료 코드 1.
// 이메일 인증 시나리오 — 가짜 SMTP 서버(sink)를 곁에 세우고, 새 DB 위에서 서버를 띄워 두드린다.
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const ROOT = process.argv[2];              // 프로젝트 루트
const WORK = process.argv[3];              // 임시 작업 폴더
const PORT = 8093, SMTP = 2525, PORT_OFF = 8092;
const tag = Date.now().toString(36).slice(-4);

let fails = 0, passes = 0;
const ok = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); c ? passes++ : fails++; };

/* ── 가짜 SMTP ── */
const mails = [];
const sink = net.createServer(sock => {
  let buf = "", data = false, raw = "", cur = { to: "" };
  sock.write("220 sink\r\n");
  sock.on("data", d => {
    buf += d.toString("utf8");
    for (;;) {
      if (data) {
        const i = buf.indexOf("\r\n.\r\n");
        if (i < 0) return;
        raw = buf.slice(0, i); buf = buf.slice(i + 5); data = false;
        const [head, body] = [raw.slice(0, raw.indexOf("\r\n\r\n")), raw.slice(raw.indexOf("\r\n\r\n") + 4)];
        const subj = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(head)?.[1];
        mails.push({ to: cur.to, head,
          subject: subj ? Buffer.from(subj, "base64").toString("utf8") : "",
          text: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") });
        sock.write("250 queued\r\n");
        continue;
      }
      const i = buf.indexOf("\r\n"); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write("250-sink\r\n250 AUTH PLAIN\r\n");
      else if (/^AUTH/i.test(line)) sock.write("235 ok\r\n");
      else if (/^MAIL/i.test(line)) sock.write("250 ok\r\n");
      else if (/^RCPT TO:<(.+)>/i.test(line)) { cur.to = /^RCPT TO:<(.+)>/i.exec(line)[1]; sock.write("250 ok\r\n"); }
      else if (/^DATA/i.test(line)) { data = true; sock.write("354 go\r\n"); }
      else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("500 ?\r\n");
    }
  });
  sock.on("error", () => {});
});
await new Promise(r => sink.listen(SMTP, "127.0.0.1", r));

/* ── 서버 띄우기 ── */
const runServer = (port, dataDir, env) => {
  rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["--no-warnings", "src/server.ts"], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  return { child, log: () => out };
};
const DATA = path.join(WORK, "data-auth"), DATA_OFF = path.join(WORK, "data-off");
const srv = runServer(PORT, DATA, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(SMTP), SMTP_PLAINTEXT_TEST: "1",
  MAIL_FROM: "noreply@habhobby.test", MAIL_DEV: "", SMTP_USER: "", SMTP_PASS: "" });
const off = runServer(PORT_OFF, DATA_OFF, { SMTP_HOST: "", SMTP_PORT: "", SMTP_PLAINTEXT_TEST: "", SMTP_USER: "", SMTP_PASS: "", MAIL_DEV: "" });
await new Promise(r => setTimeout(r, 3500));

/* ── 클라이언트 ── */
const B = `http://localhost:${PORT}`;
function client(ipHint = null) {
  let cookie = "";
  return async (method, p, body, o = {}) => {
    const headers = { "content-type": "application/json", cookie, ...(o.headers ?? {}) };
    const ip = o.ip ?? ipHint; if (ip) headers["cf-connecting-ip"] = ip;
    if (o.raw) delete headers["content-type"], Object.assign(headers, o.headers);
    const r = await fetch((o.base ?? B) + p, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)), redirect: "manual" });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { }
    return { status: r.status, ...j, _t: t };
  };
}
const codeOf = m => /\b(\d{6})\b/.exec(m.text)?.[1];
const lastMail = to => [...mails].reverse().find(m => m.to === to);
const wait = ms => new Promise(r => setTimeout(r, ms));
const db = new DatabaseSync(path.join(DATA, "habhobby.db"));
let ipn = 10; const newIp = () => `10.9.${ipn >> 8}.${ipn++ & 255}`;
const PW = "Zx9!qwLm2#";

/* 0) 메일 발송이 설정되지 않은 서버는 시작 자체를 막는다 */
{
  const c = client();
  const r = await c("POST", "/auth/password/signup/start", { loginId: "nomail1", email: "a@b.co" }, { base: `http://localhost:${PORT_OFF}` });
  ok(r.status === 503, "mail not configured → 503 (no silent success)");
}

/* 1) 가입 — 정상 경로 */
const A = client(newIp());
const emailA = `Test.${tag}@Example.COM`, emailAn = emailA.toLowerCase(), idA = `user_${tag}`;
let r = await A("POST", "/auth/password/signup", { loginId: idA, password: PW });
ok(r.status === 410 && r.ok !== true, "legacy direct signup route is closed (410): " + r.status);
r = await A("POST", "/auth/password/login", { loginId: idA, password: PW });
ok(r.status === 401, "…and it created nothing");

r = await A("POST", "/auth/password/signup/start", { loginId: idA, email: emailA });
ok(r.status === 200 && r.ok && r.ttl === 600 && r.cooldown === 60, "signup/start ok");
await wait(400);
let m = lastMail(emailAn);
ok(m && /가입 인증 코드/.test(m.subject) && /^\d{6}$/.test(codeOf(m) ?? ""), "code mail delivered to lowercased address");
ok(m && !m.text.includes(PW) && /10분/.test(m.text), "mail text sane (10 min, no secrets)");
const code = codeOf(m);
// 코드 원문이 DB 에 없다
const row = db.prepare("SELECT * FROM email_code WHERE purpose='signup' AND email=?").get(emailAn);
ok(row && row.code_mac && row.code_mac !== code && row.code_mac.length === 64, "DB holds HMAC only, not the code");
ok(row.login_id === idA, "pending row remembers the chosen id");

const wrong = code === "000000" ? "111111" : "000000";
r = await A("POST", "/auth/password/signup/verify", { email: emailA, code: wrong });
ok(r.status === 400 && /남은 횟수 4회/.test(r.reason), "wrong code → 400 with attempts left: " + r.reason);
r = await A("POST", "/auth/password/signup/verify", { email: emailA, code: "12ab" });
ok(r.status === 400 && /6자리/.test(r.reason), "malformed code rejected");
r = await A("POST", "/auth/password/signup/verify", { email: emailA, code });
ok(r.status === 200 && r.ticket?.length >= 40 && r.loginId === idA, "right code → ticket + chosen id shown");
const ticketA = r.ticket;
const row2 = db.prepare("SELECT * FROM email_code WHERE purpose='signup' AND email=?").get(emailAn);
ok(row2.code_mac === "" && row2.ticket_hash && row2.ticket_hash !== ticketA, "code consumed, ticket stored only as hash");
r = await A("POST", "/auth/password/signup/verify", { email: emailA, code });
ok(r.status === 400, "code cannot be used twice");

/* 2) 비밀번호 규칙 — 어긋나도 티켓은 살아 있다 */
const bad = [
  ["Short1!", "8자"], ["abcdefgh1", "특수"], ["abcdefgh!", "숫자"], ["12345678!", "영문"], ["Password1!", "흔한"],
  ["Xy9!aaaaQ", "네 번"], [`Q${idA}9!`, "아이디"], ["Zx9!abcd", "쓸 수 없는"], ["x".repeat(129) + "1!", "128"],
  [`${emailAn.split("@")[0]}9!Z`, "이메일"],
];
for (const [pw, word] of bad) {
  r = await A("POST", "/auth/password/signup/complete", { ticket: ticketA, password: pw });
  ok(r.status === 400 && new RegExp(word).test(r.reason), `weak password rejected (${word}): ${r.reason}`);
}
r = await A("POST", "/auth/password/signup/complete", { ticket: "x".repeat(43), password: PW });
ok(r.status === 400 && /만료/.test(r.reason), "unknown ticket rejected");
// 같은 티켓 동시에 두 번 — 하나만 이긴다
const [c1, c2] = await Promise.all([
  A("POST", "/auth/password/signup/complete", { ticket: ticketA, password: PW }),
  client(newIp())("POST", "/auth/password/signup/complete", { ticket: ticketA, password: PW }),
]);
ok([c1.status, c2.status].sort().join() === "200,400", "ticket is single-use even under a race: " + [c1.status, c2.status]);
const state = await (c1.status === 200 ? A : null)?.("GET", "/api/state");
ok(state?.me?.email === emailAn && state?.me?.provider === "password", "signed in; account carries the verified email");
const u = db.prepare("SELECT password_hash, email FROM user WHERE provider_uid = ?").get(idA);
ok(/^scrypt2:16:/.test(u.password_hash) && u.email === emailAn, "password stored as scrypt2 (N=2^16), email lowercased");
r = await client(newIp())("POST", "/auth/password/login", { loginId: idA, password: PW });
ok(r.status === 200, "login with the new password");

/* 3) 이미 가입된 메일로 가입 시도 — 겉으로는 똑같이 보인다 */
const before = mails.length;
const X = client(newIp());
r = await X("POST", "/auth/password/signup/start", { loginId: `other_${tag}`, email: emailAn });
ok(r.status === 200 && r.ttl === 600, "registered email: same 200 shape (no 'already registered' leak)");
await wait(400);
m = lastMail(emailAn);
ok(mails.length === before + 1 && /이미 가입된/.test(m.subject) && !codeOf(m), "…but the owner gets a notice mail with no code");
r = await X("POST", "/auth/password/signup/verify", { email: emailAn, code: "123456" });
const regFail = r.reason;
r = await X("POST", "/auth/password/signup/start", { loginId: `other2_${tag}`, email: `nobody_${tag}@example.com` });
await wait(200);
r = await X("POST", "/auth/password/signup/verify", { email: `nobody_${tag}@example.com`, code: "123456" });
ok(r.reason === regFail || (r.reason ?? "").replace(/\d/, "N") === (regFail ?? "").replace(/\d/, "N"),
  `verify failure text is identical for registered vs fresh email: "${regFail}" / "${r.reason}"`);
r = await client(newIp())("POST", "/auth/password/signup/start", { loginId: idA, email: `zzz_${tag}@example.com` });
ok(r.status === 409, "taken login id → 409 (ids are not secret)");

/* 4) 비밀번호 재설정 — 없는 계정도 같은 모양 */
const R = client(newIp());
const nobody = `ghost_${tag}@example.com`;
const nb = mails.length;
let r1 = await R("POST", "/auth/password/reset/start", { email: nobody });
await wait(400);
ok(r1.status === 200 && r1.ttl === 600 && mails.length === nb, "reset for unknown email: 200, and no mail is sent");
let r2 = await R("POST", "/auth/password/reset/verify", { email: nobody, code: "123456" });
const RB = client(newIp());
await RB("POST", "/auth/password/reset/start", { email: emailAn });
await wait(400);
const resetCode = codeOf(lastMail(emailAn));
let r3 = await RB("POST", "/auth/password/reset/verify", { email: emailAn, code: resetCode === "123456" ? "654321" : "123456" });
ok(r2.status === r3.status && r2.reason === r3.reason, `reset verify answers identically for unknown vs known: "${r2.reason}"`);

// 세션·공유 열쇠가 있는 상태에서 재설정
const keyRes = await A("POST", "/api/share-keys", { label: "test" });
const uid = db.prepare("SELECT id FROM user WHERE provider_uid = ?").get(idA).id;
ok(db.prepare("SELECT COUNT(*) n FROM share_key WHERE user_id = ?").get(uid).n >= 1 && db.prepare("SELECT COUNT(*) n FROM session WHERE user_id = ?").get(uid).n >= 1, "precondition: a session and a share key exist");
// 가입 티켓은 재설정에 못 쓴다 (목적이 다르다)
const rv = await RB("POST", "/auth/password/reset/verify", { email: emailAn, code: resetCode });
ok(rv.status === 200 && rv.ticket, "reset code verified");
r = await RB("POST", "/auth/password/signup/complete", { ticket: rv.ticket, password: "Nw7$kLpq9!" });
ok(r.status === 400, "a reset ticket cannot complete a signup (purpose-bound)");
r = await RB("POST", "/auth/password/reset/complete", { ticket: rv.ticket, password: "weak" });
ok(r.status === 400, "weak new password refused; ticket survives");
const NEWPW = "Nw7$kLpq9!";
r = await RB("POST", "/auth/password/reset/complete", { ticket: rv.ticket, password: NEWPW });
ok(r.status === 200, "reset complete");
await wait(400);
ok(/비밀번호가 바뀌었습니다/.test(lastMail(emailAn).subject), "change notification mail sent");
const st2 = await A("GET", "/api/state");
ok(st2.me?.provider !== "password" && st2.me?.id !== uid, "old session is dead everywhere after reset (no longer this user)");
ok(db.prepare("SELECT COUNT(*) n FROM share_key WHERE user_id = ?").get(uid).n === 0, "share keys revoked too");
r = await client(newIp())("POST", "/auth/password/login", { loginId: idA, password: PW });
ok(r.status === 401, "old password no longer works");
r = await client(newIp())("POST", "/auth/password/login", { loginId: idA, password: NEWPW });
ok(r.status === 200, "new password works");
r = await RB("POST", "/auth/password/reset/complete", { ticket: rv.ticket, password: "Qm4%zTrw8&" });
ok(r.status === 400, "ticket cannot be replayed");

/* 5) 아이디 찾기 */
const F = client(newIp());
const nf = mails.length;
r1 = await F("POST", "/auth/password/find-id", { email: emailAn });
r2 = await F("POST", "/auth/password/find-id", { email: nobody });
await wait(500);
ok(r1.status === 200 && r2.status === 200 && r1._t === r2._t, "find-id answers identically for known and unknown");
ok(mails.length === nf + 1 && lastMail(emailAn).text.includes(idA) && !codeOf(lastMail(emailAn)), "only the registered address gets its id (no code)");

/* 6) 코드 다섯 번 틀리면 죽는다 · 다시 받기 쿨다운 */
const K = client(newIp()), kEmail = `burn_${tag}@example.com`;
await K("POST", "/auth/password/signup/start", { loginId: `burn_${tag}`, email: kEmail });
await wait(400);
const kc = codeOf(lastMail(kEmail));
r = await K("POST", "/auth/password/signup/start", { loginId: `burn_${tag}`, email: kEmail });
ok(r.status === 429 && /초 뒤/.test(r.reason), "resend inside 60s → 429");
const bogus = kc === "999999" ? "888888" : "999999";
let last;
for (let i = 0; i < 5; i++) last = await K("POST", "/auth/password/signup/verify", { email: kEmail, code: bogus });
ok(/너무 여러 번/.test(last.reason), "5th wrong code burns it: " + last.reason);
r = await K("POST", "/auth/password/signup/verify", { email: kEmail, code: kc });
ok(r.status === 400 && /없거나 만료/.test(r.reason), "…and the right code no longer works");

/* 7) 만료 */
const E = client(newIp()), eEmail = `exp_${tag}@example.com`;
await E("POST", "/auth/password/signup/start", { loginId: `exp_${tag}`, email: eEmail });
await wait(400);
const ec = codeOf(lastMail(eEmail));
db.prepare("UPDATE email_code SET expires_at = ? WHERE email = ?").run(Date.now() - 1000, eEmail);
r = await E("POST", "/auth/password/signup/verify", { email: eEmail, code: ec });
ok(r.status === 400 && /만료/.test(r.reason), "expired code rejected");
await E("POST", "/auth/password/signup/start", { loginId: `exp_${tag}`, email: `exp2_${tag}@example.com` });
await wait(400);
const ec2 = codeOf(lastMail(`exp2_${tag}@example.com`));
r = await E("POST", "/auth/password/signup/verify", { email: `exp2_${tag}@example.com`, code: ec2 });
db.prepare("UPDATE email_code SET ticket_expires = ? WHERE email = ?").run(Date.now() - 1000, `exp2_${tag}@example.com`);
r = await E("POST", "/auth/password/signup/complete", { ticket: r.ticket, password: PW });
ok(r.status === 400 && /만료/.test(r.reason), "expired ticket rejected");

/* 8) 한도 — 메일 주소 · IP · 전체 */
const L = client(newIp()), lEmail = `cap_${tag}@example.com`;
for (let i = 0; i < 5; i++) db.prepare("INSERT INTO mail_log(at, email, ip, purpose) VALUES(?,?,?,?)").run(Date.now() - 1000 * i, lEmail, "1.1.1." + i, "reset");
r = await L("POST", "/auth/password/reset/start", { email: lEmail });
ok(r.status === 429, "per-email hourly cap");
const ipx = newIp();
for (let i = 0; i < 10; i++) db.prepare("INSERT INTO mail_log(at, email, ip, purpose) VALUES(?,?,?,?)").run(Date.now() - 1000 * i, `e${i}_${tag}@example.com`, ipx, "reset");
r = await client(ipx)("POST", "/auth/password/reset/start", { email: `fresh_${tag}@example.com` });
ok(r.status === 429, "per-IP hourly cap");
const capBefore = db.prepare("SELECT COUNT(*) n FROM mail_log").get().n;
db.exec("BEGIN");
for (let i = 0; i < 300; i++) db.prepare("INSERT INTO mail_log(at, email, ip, purpose) VALUES(?,?,?,?)").run(Date.now(), `g${i}@example.com`, "2.2.2." + (i % 250), "reset");
db.exec("COMMIT");
r = await client(newIp())("POST", "/auth/password/reset/start", { email: `glob_${tag}@example.com` });
ok(r.status === 429, "global daily cap protects the sender quota");
db.prepare("DELETE FROM mail_log WHERE purpose <> 'vfail'").run();

/* 9) 코드 맞히기 시도는 IP 당 따로 센다 */
const V = newIp();
for (let i = 0; i < 20; i++) await client(V)("POST", "/auth/password/reset/verify", { email: `v${i}_${tag}@example.com`, code: "000000" });
r = await client(V)("POST", "/auth/password/reset/verify", { email: emailAn, code: "000000" });
ok(r.status === 400 && /시도가 너무 많습니다/.test(r.reason), "verify attempts capped per IP");

/* 10) 요청 위조·머리글 주입 */
r = await client(newIp())("POST", "/auth/password/reset/start", "email=a%40b.co", { headers: { "content-type": "application/x-www-form-urlencoded" } });
ok(r.status === 403, "form-encoded (cross-site form) refused");
r = await client(newIp())("POST", "/auth/password/reset/start", { email: emailAn }, { headers: { "sec-fetch-site": "cross-site" } });
ok(r.status === 403, "Sec-Fetch-Site: cross-site refused");
r = await client(newIp())("POST", "/auth/password/reset/start", { email: emailAn }, { headers: { origin: "https://evil.example" } });
ok(r.status === 403, "foreign Origin refused");
for (const evil of ["a@b.co\r\nBcc: x@y.co", "a@b.co,c@d.co", "a b@c.co", "<a@b.co>", "a@b", "a@@b.co", "a..b@c.co"]) {
  r = await client(newIp())("POST", "/auth/password/find-id", { email: evil });
  ok(r.status === 400, `bad address refused: ${JSON.stringify(evil).slice(0, 34)}`);
}
ok(!mails.some(x => /Bcc:/i.test(x.head)), "no injected header ever reached a mail");

/* 11) 로그인 — 시간·맞춰보기 막기 */
const T = client(newIp());
const t0 = []; const t1 = [];
for (let i = 0; i < 3; i++) {
  let s = performance.now(); await T("POST", "/auth/password/login", { loginId: `nouser${i}${tag}`, password: "Whatever1!" }); t0.push(performance.now() - s);
  s = performance.now(); await T("POST", "/auth/password/login", { loginId: idA, password: "Whatever1!" + i }); t1.push(performance.now() - s);
}
const avg = a => a.reduce((x, y) => x + y) / a.length;
ok(Math.abs(avg(t0) - avg(t1)) / avg(t1) < 0.5, `login takes the same time for unknown vs wrong password (${avg(t0).toFixed(0)}ms vs ${avg(t1).toFixed(0)}ms)`);
const ipL = newIp(); let lock = null;
for (let i = 0; i < 42 && !lock; i++) {
  const x = await client(ipL)("POST", "/auth/password/login", { loginId: `spray${i}x${tag}`, password: "Whatever1!" });
  if (x.status === 429) lock = i;
}
ok(lock !== null && lock >= 39, `spraying many ids from one IP gets locked out (after ${lock})`);
for (let i = 0; i < 9; i++) await client(newIp())("POST", "/auth/password/login", { loginId: idA, password: "Bad" + i });
r = await client(newIp())("POST", "/auth/password/login", { loginId: idA, password: NEWPW });
ok(r.status === 429, "one id being hammered locks that id (even for the right password)");

/* 12) 게스트가 가입하면 담아 둔 것을 가져간다 */
const G = client(newIp());
await G("POST", "/auth/guest");
const gid = (await G("GET", "/api/state")).me.id;
await G("POST", "/api/folders", { name: "게스트폴더", emoji: "📁", share: { mode: "none", with: [] }, take: "" });
const gEmail = `guest_${tag}@example.com`;
await G("POST", "/auth/password/signup/start", { loginId: `gst_${tag}`, email: gEmail });
await wait(400);
const gv = await G("POST", "/auth/password/signup/verify", { email: gEmail, code: codeOf(lastMail(gEmail)) });
r = await G("POST", "/auth/password/signup/complete", { ticket: gv.ticket, password: "Gq5&hMnv2!" });
const gs = await G("GET", "/api/state");
ok(r.status === 200 && gs.me.id === gid && gs.folders.some(f => f.name === "게스트폴더") && gs.me.email === gEmail, "guest → account keeps its data and id");

/* 13) 코드가 서버 로그·응답에 남지 않는다 */
const allCodes = mails.map(codeOf).filter(Boolean);
ok(allCodes.length >= 5 && allCodes.every(c => !srv.log().includes(c)), "no issued code appears in the server log");
ok(!/scrypt|SMTP_PASS|app_secret/i.test(srv.log()), "no secrets in the server log");

console.log(`\n${passes} passed, ${fails} failed`);
srv.child.kill(); off.child.kill(); sink.close(); db.close();
process.exit(fails ? 1 : 0);
