/* 메일 보내기 — 의존성 없이 node:tls 로 SMTP 를 직접 말한다.

   인증 코드와 아이디 안내를 보내는 데만 쓴다. 받는 사람이 한 명이고 글이 짧은 글뿐이라
   SMTP 의 아주 작은 부분집합(EHLO · AUTH PLAIN · MAIL · RCPT · DATA)이면 된다.

   **자격 증명은 환경 변수로만 받는다**(SMTP_USER · SMTP_PASS · MAIL_FROM). 코드에도 저장소에도
   남지 않고, 오류 글에도 싣지 않는다.

   **암호화 없이는 보내지 않는다.** 기본은 처음부터 TLS 인 465 번 포트(인증서도 검사한다).
   암호화 없는 연결은 시험용 스위치(SMTP_PLAINTEXT_TEST=1)를 켰을 때, 그것도 **자기 컴퓨터로만**
   열린다 — 비밀번호를 평문으로 흘려보내는 설정이 실수로 켜지지 않게. */
import tls from "node:tls";
import net from "node:net";
import { randomBytes } from "node:crypto";

export type Mail = { to: string; subject: string; text: string };
export type MailMode = "smtp" | "dev" | "off";

const env = process.env;
const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1";
const isHttps = () => (env.BASE_URL ?? "").startsWith("https://");

/** 지금 메일을 어떻게 보낼 수 있는가.
    · smtp — 자격 증명이 있다(또는 시험용 로컬 서버)
    · dev  — MAIL_DEV=1 이고 **주소가 https 가 아닐 때만**: 코드를 서버 콘솔에 찍는다. 운영에서는
             켜질 수 없다 — 코드가 로그에 남는 것은 인증이 아니다.
    · off  — 보낼 길이 없다 */
export function mailMode(): MailMode {
  const host = env.SMTP_HOST ?? "smtp.gmail.com";
  if (env.SMTP_PLAINTEXT_TEST === "1" && isLoopback(host)) return "smtp";
  if (env.SMTP_USER && env.SMTP_PASS) return "smtp";
  if (env.MAIL_DEV === "1" && !isHttps()) return "dev";
  return "off";
}

/** 메일 주소로 쓸 수 있는가 — 머리글에 들어갈 값이라 줄바꿈·공백·꺾쇠는 한 글자도 받지 않는다 */
const ADDR = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}$/;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

function build(from: string, m: Mail): string {
  if (!ADDR.test(m.to) || !ADDR.test(from)) throw new Error("메일 주소 모양이 잘못되었습니다.");
  if (/[\r\n]/.test(m.subject)) throw new Error("제목에 줄바꿈이 있습니다.");
  const head = [
    `From: =?UTF-8?B?${b64("HabHobby")}?= <${from}>`,
    `To: <${m.to}>`,
    `Subject: =?UTF-8?B?${b64(m.subject)}?=`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@habhobby>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    // 자동 답장·휴가 응답이 이 주소로 되돌아오지 않게
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  ];
  // 본문은 base64 라 점(.)으로 시작하는 줄이 없다 — dot-stuffing 이 필요 없다
  return head.join("\r\n") + "\r\n\r\n" + wrap76(b64(m.text)) + "\r\n";
}

type Reply = { code: number; text: string };

function smtpSend(m: Mail): Promise<void> {
  const host = env.SMTP_HOST ?? "smtp.gmail.com";
  const port = Number(env.SMTP_PORT ?? 465);
  const plain = env.SMTP_PLAINTEXT_TEST === "1" && isLoopback(host);
  const user = env.SMTP_USER ?? "";
  // 구글이 앱 비밀번호를 「abcd efgh …」처럼 띄어 보여 주므로 그대로 붙여 넣은 값도 받는다
  const pass = (env.SMTP_PASS ?? "").replace(/\s+/g, "");
  const from = (env.MAIL_FROM || user).trim();
  const message = build(from, m);

  return new Promise<void>((resolve, reject) => {
    const sock: net.Socket = plain
      ? net.connect({ host, port })
      : tls.connect({ host, port, servername: host, minVersion: "TLSv1.2" });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return; done = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(20_000, () => finish(new Error("SMTP 응답이 없습니다.")));
    sock.on("error", e => finish(new Error("SMTP 연결 오류: " + e.message)));
    sock.on("close", () => finish(new Error("SMTP 연결이 닫혔습니다.")));

    // 한 줄씩 모아 「NNN 」(끝) 줄이 오면 한 답으로 친다. 「NNN-」는 이어지는 줄이다.
    let buf = "", cur: string[] = [];
    const queue: Reply[] = [];
    let waiter: ((r: Reply) => void) | null = null;
    sock.on("data", d => {
      buf += d.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        cur.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const r = { code: Number(line.slice(0, 3)), text: cur.join("\n") };
          cur = [];
          if (waiter) { const w = waiter; waiter = null; w(r); } else queue.push(r);
        }
      }
    });
    const reply = () => new Promise<Reply>(ok => {
      const r = queue.shift();
      if (r) ok(r); else waiter = ok;
    });
    const cmd = async (line: string | null, want: number[]) => {
      if (line !== null) sock.write(line + "\r\n");
      const r = await reply();
      // 서버가 준 글은 오류에 싣지 않는다 — 자격 증명이 되비칠 여지를 없앤다
      if (!want.includes(r.code)) throw new Error(`SMTP ${r.code} 응답`);
    };

    (async () => {
      await cmd(null, [220]);
      await cmd("EHLO habhobby", [250]);
      if (!plain || user) {
        await cmd("AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`).toString("base64"), [235]);
      }
      await cmd(`MAIL FROM:<${from}>`, [250]);
      await cmd(`RCPT TO:<${m.to}>`, [250, 251]);
      await cmd("DATA", [354]);
      sock.write(message + ".\r\n");
      await cmd(null, [250]);
      sock.write("QUIT\r\n");
      finish();
    })().catch(e => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

/** 메일을 보낸다. 보낼 길이 없으면 `off` 오류를 던진다. */
export async function sendMail(m: Mail): Promise<void> {
  const mode = mailMode();
  if (mode === "off") throw new Error("mail-off");
  if (mode === "dev") {
    // 시험용 — 운영(https)에서는 이 길이 열리지 않는다
    console.log(`[mail-dev] → ${m.to}\n  ${m.subject}\n${m.text.split("\n").map(l => "  " + l).join("\n")}`);
    return;
  }
  await smtpSend(m);
}
