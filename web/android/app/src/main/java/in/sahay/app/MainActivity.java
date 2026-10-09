package in.sahay.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import sahay.nearby.SahayNearbyPlugin;
import sahay.securestore.SahaySecureStorePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate.
        registerPlugin(SahayNearbyPlugin.class);
        registerPlugin(SahaySecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
