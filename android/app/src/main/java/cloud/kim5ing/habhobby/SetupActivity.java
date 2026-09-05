package cloud.kim5ing.habhobby;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** 열쇠를 붙여 넣는 화면.
 *
 *  <p>화면 하나에 칸 하나뿐이라 레이아웃 xml 을 따로 두지 않았다 — 파일을 오갈수록
 *  「어디에 뭐가 있나」만 늘어난다. 여기서 다 보인다. */
public class SetupActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    int pad = dp(20);
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setPadding(pad, pad, pad, pad);
    box.setGravity(Gravity.CENTER_VERTICAL);

    final EditText input = new EditText(this);
    input.setHint(R.string.setup_hint);
    input.setSingleLine(true);
    // 자동 대문자·자동 고침이 열쇠를 조용히 망가뜨린다 — 붙여 넣은 그대로여야 한다.
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    input.setText(Keys.get(this));

    TextView help = new TextView(this);
    help.setText(R.string.setup_help);
    help.setPadding(0, dp(12), 0, dp(16));

    Button save = new Button(this);
    save.setText(R.string.setup_save);
    save.setOnClickListener(v -> {
      String key = input.getText().toString().trim();
      Keys.set(this, key);
      Toast.makeText(this,
          key.isEmpty() ? "열쇠를 지웠습니다" : "저장했습니다. 이제 공유로 담을 수 있습니다",
          Toast.LENGTH_LONG).show();
      finish();
    });

    box.addView(input);
    box.addView(help);
    box.addView(save);
    setContentView(box);
  }

  private int dp(int v) {
    return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
  }
}
