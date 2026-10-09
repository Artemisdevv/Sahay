package in.sahay.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import sahay.nearby.SahayNearbyPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SahayNearbyPlugin.class);  // must run before super.onCreate
        super.onCreate(savedInstanceState);
    }
}
