package com.focusisland.companion;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.*;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.os.*;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

@SuppressLint("MissingPermission") // Every entry and asynchronous callback is gated by runtime grants.
public final class SharingService extends Service {
    static final String STOP = "com.focusisland.companion.STOP";
    private static final String CHANNEL = "sharing";
    private static final int NOTIFICATION_ID = 10;
    private static final int ATT_INSUFFICIENT_AUTHORIZATION = 0x08; // ATT error code predates Android API 33 constant.
    private static volatile SharingService active;
    private static volatile String displayStatus = "尚未开始共享";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OutboundQueue queue = new OutboundQueue();
    private final Set<String> forwarded = new HashSet<>();
    private BluetoothAdapter adapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic characteristic;
    private AdvertiseCallback advertiseCallback;
    private BluetoothDevice peer;
    private SettingsStore preferences;
    private String computer;
    private boolean nameOnly, whitelist, subscribed, closed, receiverRegistered;
    private Set<String> packages;
    private int mtu = 23, generation, sendToken;
    private ContentObserver accessObserver;

    static boolean running() { return active != null; }
    static String status() { return displayStatus; }

    static boolean bluetoothPermissions(Context context) {
        return Build.VERSION.SDK_INT < 31 ||
                (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED);
    }

    static void listenerChanged() {
        SharingService instance = active;
        if (instance != null) instance.handler.post(() -> instance.listenerStateChanged());
    }

    static void posted(StatusBarNotification notification) {
        SharingService instance = active;
        // NotificationListenerService callbacks run on the main thread on our API 26+ baseline.
        // Process directly so notification floods cannot create an unbounded Handler payload queue.
        if (instance != null) {
            try { instance.forward(notification); }
            catch (RuntimeException ignored) { /* A malformed third-party notification is skipped without logging content. */ }
        }
    }

    static void removed(StatusBarNotification notification) {
        SharingService instance = active;
        if (instance != null && notification != null && instance.canSend()) {
            String id = Protocol.id(notification.getKey());
            if (instance.forwarded.remove(id)) instance.enqueue(Protocol.removed(id));
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "通知共享状态", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            finish("共享已停止");
            return START_NOT_STICKY;
        }
        if (active == this) return START_NOT_STICKY;
        preferences = new SettingsStore(this);
        computer = preferences.computer();
        nameOnly = preferences.nameOnly();
        whitelist = preferences.whitelist();
        packages = preferences.packages();
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        adapter = manager == null ? null : manager.getAdapter();
        if (!bluetoothPermissions(this) || !NotificationRelay.hasAccess(this) || computer.isEmpty()) {
            finish("请先授权并选择已配对电脑");
            return START_NOT_STICKY;
        }
        try {
            if (adapter == null || !adapter.isEnabled() || !adapter.isMultipleAdvertisementSupported()
                    || !selectedStillBonded()) {
                finish("请开启蓝牙，并先在系统中完成电脑配对");
                return START_NOT_STICKY;
            }
            advertiser = adapter.getBluetoothLeAdvertiser();
            if (advertiser == null) { finish("此设备不支持蓝牙广播"); return START_NOT_STICKY; }
            Notification ongoing = serviceNotification();
            if (Build.VERSION.SDK_INT >= 29)
                startForeground(NOTIFICATION_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(NOTIFICATION_ID, ongoing);
            active = this;
            registerSafetyObservers();
            openGatt();
            if (!NotificationRelay.isConnected()) NotificationRelay.rebind(this);
            handler.post(healthCheck);
        } catch (SecurityException exception) {
            finish("蓝牙或后台服务授权已失效，请重新授权");
        } catch (RuntimeException exception) {
            finish("无法启动蓝牙共享，请检查系统蓝牙设置");
        }
        return START_NOT_STICKY;
    }

    private Notification serviceNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, SharingService.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_island).setContentTitle("Focus Island 正在共享通知")
                .setContentText("仅向已选电脑共享 · 点此管理")
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(null, "停止共享", stop).build())
                .build();
    }

    private void registerSafetyObservers() {
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        filter.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);

        if (Build.VERSION.SDK_INT >= 33) registerReceiver(safetyReceiver, filter, Context.RECEIVER_EXPORTED);
        else registerReceiver(safetyReceiver, filter);
        receiverRegistered = true;
        accessObserver = new ContentObserver(handler) {
            @Override public void onChange(boolean selfChange) {
                if (!NotificationRelay.hasAccess(SharingService.this)) finish("通知访问权限已撤销，共享已停止");
            }
        };
        getContentResolver().registerContentObserver(
                Settings.Secure.getUriFor("enabled_notification_listeners"), false, accessObserver);
    }

    private final BroadcastReceiver safetyReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (closed) return;
            String action = intent.getAction();
            if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(action)) {
                if (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR) != BluetoothAdapter.STATE_ON)
                    finish("蓝牙已关闭，共享已停止");
            } else if (!bluetoothPermissions(SharingService.this) || !selectedStillBonded()) {
                finish("所选电脑的配对已移除，共享已停止");
            }
        }
    };

    private final Runnable healthCheck = new Runnable() {
        @Override public void run() {
            if (closed || active != SharingService.this) return;
            try {
                if (!bluetoothPermissions(SharingService.this) || !NotificationRelay.hasAccess(SharingService.this)
                        || !adapter.isEnabled() || !selectedStillBonded()) {
                    finish("权限、蓝牙或电脑配对已失效，共享已停止");
                    return;
                }
            } catch (SecurityException exception) { finish("蓝牙权限已撤销，共享已停止"); return; }
            handler.postDelayed(this, 2000);
        }
    };

    private boolean selectedStillBonded() {
        if (adapter == null || !bluetoothPermissions(this)) return false;
        try {
            for (BluetoothDevice device : adapter.getBondedDevices()) if (allowed(device)) return true;
        } catch (SecurityException ignored) { return false; }
        return false;
    }

    private boolean allowed(BluetoothDevice device) {
        if (device == null || !bluetoothPermissions(this)) return false;
        try { return SharePolicy.authorized(computer, device.getAddress(),
                device.getBondState() == BluetoothDevice.BOND_BONDED); }
        catch (SecurityException ignored) { return false; }
    }

    private void route(int token, Runnable callback) {
        handler.post(() -> {
            if (!closed && token == generation && active == this) {
                if (!bluetoothPermissions(this)) finish("蓝牙权限已撤销，共享已停止");
                else {
                    try { callback.run(); }
                    catch (SecurityException exception) { finish("蓝牙权限已撤销，共享已停止"); }
                    catch (RuntimeException exception) { finish("蓝牙连接异常，请重新开始共享"); }
                }
            }
        });
    }

    private void openGatt() {
        if (closed) return;
        final int token = ++generation;
        displayStatus = "正在启动蓝牙共享…";
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        server = manager.openGattServer(this, new BluetoothGattServerCallback() {
            @Override public void onServiceAdded(int status, BluetoothGattService service) {
                route(token, () -> {
                    if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising(token);
                    else finish("无法注册通知蓝牙服务，请重试");
                });
            }

            @Override public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                route(token, () -> {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        if (!allowed(device)) { server.cancelConnection(device); return; }
                        if (peer != null && !peer.equals(device)) { server.cancelConnection(device); return; }
                        peer = device;
                        mtu = 23;
                        displayStatus = "电脑已连接，等待安全订阅";
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED && peer != null && peer.equals(device)) {
                        restartConnection("连接已断开，等待电脑重新连接");
                    }
                });
            }

            @Override public void onMtuChanged(BluetoothDevice device, int value) {
                route(token, () -> { if (peer != null && peer.equals(device)) mtu = Math.max(23, Math.min(517, value)); });
            }

            @Override public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset,
                                                           BluetoothGattDescriptor descriptor) {
                route(token, () -> {
                    int result = !allowed(device) ? ATT_INSUFFICIENT_AUTHORIZATION
                            : offset != 0 ? BluetoothGatt.GATT_INVALID_OFFSET : BluetoothGatt.GATT_SUCCESS;
                    server.sendResponse(device, requestId, result, offset,
                            result == BluetoothGatt.GATT_SUCCESS ? new byte[]{(byte) (subscribed ? 1 : 0), 0} : null);
                });
            }

            @Override public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattDescriptor descriptor, boolean preparedWrite, boolean responseNeeded,
                    int offset, byte[] value) {
                byte[] copy = value == null ? new byte[0] : value.clone();
                route(token, () -> {
                    int result;
                    if (!allowed(device) || peer == null || !peer.equals(device))
                        result = ATT_INSUFFICIENT_AUTHORIZATION;
                    else if (preparedWrite || !Protocol.CCCD_UUID.equals(descriptor.getUuid().toString()))
                        result = BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED;
                    else if (offset != 0) result = BluetoothGatt.GATT_INVALID_OFFSET;
                    else if (copy.length != 2 || copy[1] != 0 || (copy[0] != 0 && copy[0] != 1))
                        result = BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED;
                    else result = BluetoothGatt.GATT_SUCCESS;
                    if (responseNeeded) server.sendResponse(device, requestId, result, offset, null);
                    if (result == BluetoothGatt.GATT_SUCCESS) {
                        if (copy[0] == 0) {
                            restartConnection("电脑已取消订阅，等待重新连接");
                        } else if (!subscribed) {
                            resetSession();
                            subscribed = true;
                            displayStatus = "已连接 · 正在向所选电脑共享";
                            enqueue(statusMessage());
                        }
                    }
                });
            }

            @Override public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset,
                                                               BluetoothGattCharacteristic characteristic) {
                route(token, () -> server.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null));
            }

            @Override public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattCharacteristic characteristic, boolean preparedWrite, boolean responseNeeded,
                    int offset, byte[] value) {
                route(token, () -> {
                    if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null);
                });
            }

            @Override public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
                route(token, () -> server.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null));
            }

            @Override public void onNotificationSent(BluetoothDevice device, int status) {
                route(token, () -> {
                    if (!subscribed || peer == null || !peer.equals(device) || !queue.waiting()) return;
                    ++sendToken;
                    if (!queue.acknowledge(status == BluetoothGatt.GATT_SUCCESS))
                        restartConnection("发送中断，等待电脑重新连接");
                    else pump();
                });
            }
        });
        if (server == null) { finish("无法启动蓝牙 GATT 服务"); return; }
        BluetoothGattService service = new BluetoothGattService(UUID.fromString(Protocol.SERVICE_UUID),
                BluetoothGattService.SERVICE_TYPE_PRIMARY);
        characteristic = new BluetoothGattCharacteristic(UUID.fromString(Protocol.NOTIFY_UUID),
                BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0);
        characteristic.addDescriptor(new BluetoothGattDescriptor(UUID.fromString(Protocol.CCCD_UUID),
                BluetoothGattDescriptor.PERMISSION_READ_ENCRYPTED | BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED));
        service.addCharacteristic(characteristic);
        if (!server.addService(service)) finish("无法添加通知蓝牙服务");
    }

    private void startAdvertising(int token) {
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                route(token, () -> displayStatus = "共享已开启，等待所选电脑连接");
            }
            @Override public void onStartFailure(int errorCode) {
                route(token, () -> finish(errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE
                        ? "手机蓝牙名称过长，请在系统设置缩短名称后重试" : "蓝牙广播启动失败，请检查蓝牙并重试"));
            }
        };
        AdvertiseSettings settings = new AdvertiseSettings.Builder().setConnectable(true)
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).setTimeout(0).build();
        AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(UUID.fromString(Protocol.SERVICE_UUID))).build();
        AdvertiseData scanResponse = new AdvertiseData.Builder().setIncludeDeviceName(true).build();
        advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback);
    }

    private void resetSession() {
        subscribed = false;
        queue.clear();
        forwarded.clear();
        ++sendToken;
    }

    private void closeGatt() {
        ++generation; // All callbacks from the old server become inert.
        resetSession();
        if (advertiseCallback != null && advertiser != null && bluetoothPermissions(this)) {
            try { advertiser.stopAdvertising(advertiseCallback); } catch (RuntimeException ignored) {}
        }
        advertiseCallback = null;
        if (server != null) {
            try {
                if (peer != null && bluetoothPermissions(this)) server.cancelConnection(peer);
                server.close();
            } catch (RuntimeException ignored) {}
        }
        server = null;
        characteristic = null;
        peer = null;
        mtu = 23;
    }

    private void restartConnection(String message) {
        if (closed) return;
        closeGatt();
        displayStatus = message;
        int restartToken = generation;
        handler.postDelayed(() -> {
            if (closed || restartToken != generation) return;
            if (!bluetoothPermissions(this) || !NotificationRelay.hasAccess(this)) { finish("权限已撤销，共享已停止"); return; }
            try { openGatt(); } catch (RuntimeException exception) { finish("蓝牙连接异常，请重新开始共享"); }
        }, 350);
    }

    private boolean canSend() {
        return !closed && active == this && subscribed && peer != null && allowed(peer)
                && NotificationRelay.hasAccess(this) && NotificationRelay.isConnected();
    }

    private byte[] statusMessage() {
        return Protocol.status(NotificationRelay.hasAccess(this) && NotificationRelay.isConnected(),
                Build.MANUFACTURER + " " + Build.MODEL);
    }

    private void listenerStateChanged() {
        if (closed || active != this) return;
        if (!NotificationRelay.hasAccess(this)) { finish("通知访问权限已撤销，共享已停止"); return; }
        if (!NotificationRelay.isConnected()) {
            if (peer != null) restartConnection("通知监听暂时断开，等待系统恢复");
            NotificationRelay.rebind(this);
        } else if (subscribed) enqueue(statusMessage());
    }

    private void forward(StatusBarNotification sbn) {
        if (!canSend() || sbn == null) return;
        Notification notification = sbn.getNotification();
        String id = Protocol.id(sbn.getKey());
        boolean permitted = SharePolicy.allows(getPackageName(), sbn.getPackageName(), sbn.isOngoing(),
                (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0, whitelist, packages);
        if (!permitted) {
            if (forwarded.remove(id)) enqueue(Protocol.removed(id));
            return;
        }
        // Bound both memory and desktop state; overflow is a fresh connection, not a partial stream.
        if (!forwarded.contains(id) && forwarded.size() >= 512) {
            restartConnection("通知过多，正在重新建立共享连接");
            return;
        }
        String app = sbn.getPackageName();
        try { app = getPackageManager().getApplicationLabel(
                getPackageManager().getApplicationInfo(sbn.getPackageName(), 0)).toString(); }
        catch (PackageManager.NameNotFoundException ignored) {}
        CharSequence title = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence body = notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (body == null || body.length() == 0) body = notification.extras.getCharSequence(Notification.EXTRA_TEXT);
        if (enqueue(Protocol.posted(id, app, sbn.getPackageName(), title, body, sbn.getPostTime(), nameOnly)))
            forwarded.add(id);
    }

    private boolean enqueue(byte[] payload) {
        if (!subscribed || peer == null || closed || !allowed(peer)) return false;
        if (!queue.offer(payload)) { restartConnection("通知队列已满，正在重新连接"); return false; }
        pump();
        return subscribed;
    }

    private void pump() {
        if (closed || !subscribed || server == null || peer == null || !allowed(peer)) return;
        if (!NotificationRelay.hasAccess(this)) { finish("通知访问权限已撤销，共享已停止"); return; }
        byte[] next = queue.next(mtu);
        if (next == null) return;
        boolean accepted;
        try {
            if (Build.VERSION.SDK_INT >= 33)
                accepted = server.notifyCharacteristicChanged(peer, characteristic, false, next) == BluetoothStatusCodes.SUCCESS;
            else {
                characteristic.setValue(next);
                accepted = server.notifyCharacteristicChanged(peer, characteristic, false);
            }
        } catch (RuntimeException exception) { accepted = false; }
        if (!accepted) { restartConnection("蓝牙发送失败，等待电脑重新连接"); return; }
        int token = ++sendToken;
        handler.postDelayed(() -> {
            if (!closed && token == sendToken && queue.waiting()) restartConnection("蓝牙响应超时，等待电脑重新连接");
        }, 10000);
    }

    private void finish(String message) {
        if (closed) return;
        displayStatus = message;
        closed = true;
        if (active == this) active = null;
        handler.removeCallbacksAndMessages(null);
        closeGatt();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        finish("共享已停止");
        if (receiverRegistered) unregisterReceiver(safetyReceiver);
        if (accessObserver != null) getContentResolver().unregisterContentObserver(accessObserver);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
