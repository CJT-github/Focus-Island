package com.focusisland.companion;

import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public final class NotificationRelay extends NotificationListenerService {
    private static volatile boolean connected;
    static boolean isConnected() { return connected; }

    static boolean hasAccess(Context context) {
        ComponentName expected = new ComponentName(context, NotificationRelay.class);
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                return manager != null && manager.isNotificationListenerAccessGranted(expected);
            }
            String enabled = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
            if (enabled == null) return false;
            for (String item : enabled.split(":"))
                if (expected.equals(ComponentName.unflattenFromString(item))) return true;
        } catch (SecurityException ignored) { return false; }
        return false;
    }

    static void rebind(Context context) {
        try {
            if (hasAccess(context)) requestRebind(new ComponentName(context, NotificationRelay.class));
        } catch (SecurityException ignored) {
            // The user can revoke access between the check and the rebind request.
        }
    }

    @Override public void onListenerConnected() {
        connected = true;
        SharingService.listenerChanged();
        // Deliberately do not enumerate active notifications: sharing starts with future events.
    }
    @Override public void onListenerDisconnected() {
        connected = false;
        SharingService.listenerChanged();
    }
    @Override public void onDestroy() {
        connected = false;
        SharingService.listenerChanged();
        super.onDestroy();
    }
    @Override public void onNotificationPosted(StatusBarNotification notification) {
        SharingService.posted(notification);
    }
    @Override public void onNotificationRemoved(StatusBarNotification notification) {
        SharingService.removed(notification);
    }
}
