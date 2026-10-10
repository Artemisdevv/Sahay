package in.sahay.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import sahay.nearby.SahayNearbyPlugin;
import sahay.securestore.SahaySecureStorePlugin;
import sahay.sms.SahaySmsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before super.onCreate.
        registerPlugin(SahayNearbyPlugin.class);
        registerPlugin(SahaySecureStorePlugin.class);
        registerPlugin(SahaySmsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
