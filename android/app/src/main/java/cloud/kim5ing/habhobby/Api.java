package cloud.kim5ing.habhobby;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** 서버로 가는 길. **한 자리에만 둔다** — 담는 쪽(ShareActivity)과 열쇠를 확인하는
 *  쪽(SetupActivity)이 같은 요청을 보내므로, 두 벌로 두면 한쪽만 고치게 된다.
 *
 *  <p>빈 주소를 보내면 서버는 아무것도 담지 않고 {@code saved:false} 로 답한다. 그래서
 *  그것이 그대로 <b>열쇠가 맞는지 물어보는 길</b>이 된다 — 확인만 하는 창구를 따로 낼
 *  까닭이 없다. 열쇠가 틀리면 401 이 오고, 그건 담을 때와 똑같은 판단이다. */
final class Api {

  static final class Result {
    final int code;        // -1 이면 아예 못 갔다
    final String body;
    final String error;    // 못 갔을 때의 까닭 한 낱말

    Result(int code, String body, String error) {
      this.code = code; this.body = body; this.error = error;
    }
    boolean reached() { return code > 0; }
  }

  private Api() {}

  static Result share(String endpoint, String key, String text) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(endpoint).openConnection();
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setConnectTimeout(10_000);
      /* 서버가 남의 사이트에 다녀와 제목을 읽는다 — 그 왕복이 있으므로 넉넉히 기다린다.
         짧게 잡으면 느린 사이트마다 「담지 못했습니다」가 뜨는데 정작 서버에는 담겨 있다. */
      c.setReadTimeout(45_000);
      c.setRequestProperty("Authorization", "Bearer " + key);
      c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");

      byte[] body = ("url=" + URLEncoder.encode(text, "UTF-8")).getBytes(StandardCharsets.UTF_8);
      c.setFixedLengthStreamingMode(body.length);
      try (OutputStream os = c.getOutputStream()) { os.write(body); }

      int code = c.getResponseCode();
      return new Result(code, read(code >= 400 ? c.getErrorStream() : c.getInputStream()), null);
    } catch (Exception e) {
      /* 무엇이 잘못됐는지 한 낱말이라도 남긴다. 화면이 없는 쪽에서는 「조용히 아무 일도
         안 일어남」이 가장 고치기 어려운 고장이다. */
      return new Result(-1, "", e.getClass().getSimpleName());
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private static String read(InputStream in) throws Exception {
    if (in == null) return "{}";
    try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buf = new byte[4096];
      for (int n; (n = is.read(buf)) > 0; ) out.write(buf, 0, n);
      return out.toString(StandardCharsets.UTF_8.name());
    }
  }
}
