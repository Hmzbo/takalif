package app.takalif.companion;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered BEFORE super.onCreate: BridgeActivity.onCreate
        // builds the Capacitor Bridge inside super.onCreate, so any plugin
        // added afterwards is silently ignored.
        registerPlugin(PinnedHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
