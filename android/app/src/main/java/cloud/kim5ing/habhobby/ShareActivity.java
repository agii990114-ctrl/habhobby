package cloud.kim5ing.habhobby;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

/** 다른 앱에서 「공유」로 넘어온 주소를 담는다.
 *
 *  <p><b>창을 띄우지 않는다.</b> 웹앱(PWA)의 공유 대상은 규격상 반드시 앱이 떠야 해서,
 *  누르면 화면이 한 번 번쩍였다. 이 앱을 만든 까닭이 그것 하나다 — 여기서는 보내고 끝낸다.
 *
 *  <p><b>쿠키를 쓸 수 없다.</b> 이 요청은 크롬 밖에서 나가므로 웹에서 한 로그인이 따라오지
 *  않는다(그건 TWA 로 띄운 화면에서만 그렇다). 그래서 공유 열쇠를 머리글에 얹는다.
 *
 *  <p><b>담기지 않았으면 앱을 연다.</b> 제목을 못 읽은 주소는 서버가 담지 않고
 *  {@code saved:false} 와 열 주소를 함께 준다. 조용히 아무 일도 없는 것보다, 사람이 보고
 *  정하도록 화면을 띄우는 편이 낫다 — 화면 없이 실패하면 물어볼 데가 없다. */
public class ShareActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    final String text = sharedText(getIntent());
    if (text.isEmpty()) { done("보낼 주소가 없습니다", null); return; }

    final String key = Keys.get(this);
    if (key.isEmpty()) {
      /* 열쇠가 없으면 넣는 화면으로 보낸다. 여기서 조용히 실패하면 「공유가 안 되네」로만
         보이고, 무엇을 해야 하는지 알 길이 없다. */
      Toast.makeText(this, "먼저 공유 열쇠를 넣어 주세요", Toast.LENGTH_LONG).show();
      startActivity(new Intent(this, SetupActivity.class));
      finish();
      return;
    }

    new Thread(() -> send(key, text)).start();
  }

  /** 「제목 https://…」처럼 글이 섞여 와도 그대로 보낸다 — 주소만 골라내는 일은 서버가 한다. */
  private static String sharedText(Intent it) {
    if (it == null || !Intent.ACTION_SEND.equals(it.getAction())) return "";
    String s = it.getStringExtra(Intent.EXTRA_TEXT);
    if (s == null) s = it.getStringExtra(Intent.EXTRA_SUBJECT);
    return s == null ? "" : s.trim();
  }

  private void send(String key, String text) {
    String msg;
    String open = null;
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(getString(R.string.share_endpoint)).openConnection();
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setConnectTimeout(10_000);
      /* 서버가 남의 사이트에 다녀와 제목을 읽는다 — 그 왕복이 있으므로 넉넉히 기다린다.
         짧게 잡으면 느린 사이트마다 「담지 못했습니다」가 뜨는데, 정작 서버에는 담겨 있다. */
      c.setReadTimeout(45_000);
      c.setRequestProperty("Authorization", "Bearer " + key);
      c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");

      byte[] body = ("url=" + URLEncoder.encode(text, "UTF-8")).getBytes(StandardCharsets.UTF_8);
      c.setFixedLengthStreamingMode(body.length);
      try (OutputStream os = c.getOutputStream()) { os.write(body); }

      int code = c.getResponseCode();
      String raw = read(code >= 400 ? c.getErrorStream() : c.getInputStream());

      if (code == 401) {
        msg = "공유 열쇠가 맞지 않습니다";
      } else if (code >= 400) {
        msg = "담지 못했습니다 (" + code + ")";
      } else {
        JSONObject j = new JSONObject(raw);
        if (j.optBoolean("saved")) {
          String title = j.optString("title", "");
          msg = title + (j.optBoolean("made") ? " — 담았습니다" : " — 이미 있습니다");
        } else {
          msg = "제목을 못 읽어 앱에서 확인합니다";
          open = j.optString("open", "");
        }
      }
    } catch (Exception e) {
      /* 무엇이 잘못됐는지 한 낱말이라도 남긴다. 화면이 없는 쪽에서 「조용히 아무 일도
         안 일어남」이 가장 고치기 어려운 고장이다. */
      msg = "담지 못했습니다 — " + e.getClass().getSimpleName();
    } finally {
      if (c != null) c.disconnect();
    }

    final String m = msg;
    final String o = open;
    runOnUiThread(() -> done(m, o));
  }

  private static String read(InputStream in) throws Exception {
    if (in == null) return "{}";
    try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buf = new byte[4096];
      for (int n; (n = is.read(buf)) > 0; ) out.write(buf, 0, n);
      return out.toString(StandardCharsets.UTF_8.name());
    }
  }

  private void done(String msg, String open) {
    Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show();
    if (open != null && !open.isEmpty()) {
      Intent go = new Intent(Intent.ACTION_VIEW, Uri.parse(open));
      go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      try { startActivity(go); } catch (Exception ignored) { /* 열 데가 없으면 토스트로 끝 */ }
    }
    finish();
  }
}
