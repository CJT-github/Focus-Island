package com.focusisland.companion;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.*;
import android.bluetooth.*;
import android.content.*;
import android.content.pm.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressLint({"MissingPermission", "SetTextI18n"})
public final class MainActivity extends Activity {
    private static final int GOLD = Color.rgb(214, 188, 130);
    private static final int TEXT = Color.rgb(234, 236, 231);
    private static final int MUTED = Color.rgb(159, 167, 163);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private SettingsStore preferences;
    private BluetoothAdapter adapter;
    private TextView state, permissionState, filterSummary;
    private Spinner computers;
    private CheckBox nameOnly, whitelist;
    private Button share, filter, refresh, discover;
    private boolean fillingDevices;
    private final List<BondedChoice> choices = new ArrayList<>();

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = new SettingsStore(this);
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        adapter = manager == null ? null : manager.getAdapter();
        buildUi();
    }

    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + .5f); }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(17, 20, 21));
        scroll.setFillViewport(true);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(22), dp(24), dp(28));
        scroll.addView(page);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                page.setPadding(dp(24) + bars.left, dp(22) + bars.top, dp(24) + bars.right, dp(28) + bars.bottom);
            } else page.setPadding(dp(24) + insets.getSystemWindowInsetLeft(),
                    dp(22) + insets.getSystemWindowInsetTop(), dp(24) + insets.getSystemWindowInsetRight(),
                    dp(28) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        setContentView(scroll);

        TextView brand = text(page, "FOCUS ISLAND", 13, GOLD);
        brand.setLetterSpacing(.18f);
        TextView heading = text(page, "把手机通知\n带到灵动岛", 30, TEXT);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        text(page, "通过蓝牙，仅共享给你选择的那台电脑。无需账号或网络。", 15, MUTED);
        space(page, 20);
        state = text(page, "尚未开始共享", 18, GOLD);
        permissionState = text(page, "", 13, MUTED);
        space(page, 18);
        section(page, "1  ·  授权");
        button(page, "允许通知访问", () -> openSettings(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        button(page, "允许附近设备与状态通知", this::requestPermissions);
        text(page, "通知访问用于读取其他应用的通知。附近设备用于蓝牙共享；状态通知提供随时停止入口。", 13, MUTED);
        space(page, 18);
        section(page, "2  ·  配对并选择电脑");
        discover = button(page, "让手机可被发现 / 首次配对", this::requestDiscoverable);
        text(page, "先在 Windows 设置 → 蓝牙 → 添加设备中选择手机，在两端核对并手动确认配对码。返回这里刷新，然后选择电脑。", 13, MUTED);
        computers = new Spinner(this);
        computers.setContentDescription("允许接收通知的已配对电脑");
        page.addView(computers, new LinearLayout.LayoutParams(-1, dp(56)));
        computers.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (!fillingDevices && !SharingService.running() && position >= 0 && position < choices.size())
                    preferences.computer(choices.get(position).address);
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });
        refresh = button(page, "刷新已配对设备", this::loadComputers);
        button(page, "打开系统蓝牙设置", () -> openSettings(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)));
        space(page, 18);
        section(page, "3  ·  决定共享内容");
        nameOnly = new CheckBox(this);
        nameOnly.setText("仅显示应用名（隐藏标题与正文）");
        nameOnly.setTextColor(TEXT);
        nameOnly.setChecked(preferences.nameOnly());
        nameOnly.setOnCheckedChangeListener((button, checked) -> {
            if (!SharingService.running()) preferences.nameOnly(checked);
        });
        page.addView(nameOnly);
        whitelist = new CheckBox(this);
        whitelist.setText("仅共享我选择的应用");
        whitelist.setTextColor(TEXT);
        whitelist.setChecked(preferences.whitelist());
        whitelist.setOnCheckedChangeListener((button, checked) -> {
            if (!SharingService.running()) preferences.whitelist(checked);
            updateUi();
        });
        page.addView(whitelist);
        filter = button(page, "选择应用", this::chooseApps);
        filterSummary = text(page, "", 13, MUTED);
        text(page, "默认允许普通通知，忽略本应用、常驻通知和分组摘要。锁屏时继续共享系统提供的内容。系统隐藏或脱敏的通知无法恢复。", 13, MUTED);
        space(page, 22);
        share = button(page, "开始共享", this::toggleSharing);
        share.setTextColor(Color.rgb(17, 20, 21));
        share.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GOLD));
        text(page, "开始后，在电脑 Focus Island 中扫描并连接此手机。连接只发送状态，随后转发新通知，不补发历史通知。修改电脑或隐私设置前，请先停止共享。", 13, MUTED);
        text(page, "仅展示通知，不代点通知或回复。通知内容仅在内存中转发，不保存到文件。", 12, MUTED);
        updateUi();
    }

    private void section(LinearLayout parent, String value) { text(parent, value, 17, TEXT).setTypeface(Typeface.DEFAULT, Typeface.BOLD); }
    private TextView text(LinearLayout parent, String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setLineSpacing(dp(3), 1);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(10);
        parent.addView(view, params);
        return view;
    }
    private void space(LinearLayout parent, int height) { parent.addView(new View(this), new LinearLayout.LayoutParams(1, dp(height))); }
    private Button button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label); button.setAllCaps(false); button.setTextSize(15);
        button.setMinHeight(dp(48));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(4);
        parent.addView(button, params);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void openSettings(Intent intent) {
        try { startActivity(intent); }
        catch (ActivityNotFoundException exception) { toast("此系统未提供该设置页面，请在手机设置中手动打开"); }
        catch (SecurityException exception) { toast("系统拒绝此操作，请在手机设置中手动打开"); }
    }

    private void requestPermissions() {
        List<String> required = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) required.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) required.add(Manifest.permission.BLUETOOTH_ADVERTISE);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            required.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!required.isEmpty()) requestPermissions(required.toArray(new String[0]), 1);
        else toast("所需权限已授权");
    }

    private void requestDiscoverable() {
        if (!SharingService.bluetoothPermissions(this)) { requestPermissions(); return; }
        if (adapter == null) { toast("此手机不支持蓝牙"); return; }
        // The system owns discovery and pairing dialogs. Never intercept or accept pairing requests.
        openSettings(new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE)
                .putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120));
    }

    private void loadComputers() {
        if (computers == null) return;
        fillingDevices = true;
        choices.clear();
        choices.add(new BondedChoice("", "请选择允许接收通知的电脑"));
        if (adapter != null && SharingService.bluetoothPermissions(this)) {
            try {
                List<BondedChoice> devices = new ArrayList<>();
                for (BluetoothDevice device : adapter.getBondedDevices()) {
                    String address = device.getAddress();
                    String name = device.getName();
                    devices.add(new BondedChoice(address, Protocol.clip(name == null ? "未命名设备" : name, 60)
                            + " · " + address.substring(Math.max(0, address.length() - 5))));
                }
                devices.sort(Comparator.comparing(item -> item.label));
                choices.addAll(devices);
            } catch (SecurityException ignored) {}
        }
        ArrayAdapter<BondedChoice> list = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, choices);
        list.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        computers.setAdapter(list);
        int selected = 0;
        for (int i = 1; i < choices.size(); i++) if (choices.get(i).address.equals(preferences.computer())) selected = i;
        if (selected == 0 && !SharingService.running()) preferences.computer("");
        computers.setSelection(selected);
        // Spinner selection callbacks are delivered after layout.
        computers.post(() -> fillingDevices = false);
        updateUi();
    }

    private void toggleSharing() {
        if (SharingService.running()) {
            stopService(new Intent(this, SharingService.class));
            handler.postDelayed(this::updateUi, 150);
            return;
        }
        if (!NotificationRelay.hasAccess(this)) { toast("请先允许通知访问"); return; }
        if (!SharingService.bluetoothPermissions(this)) { requestPermissions(); return; }
        if (preferences.computer().isEmpty()) { toast("请先在系统配对，然后选择允许接收通知的电脑"); return; }
        try {
            if (adapter == null || !adapter.isEnabled()) {
                openSettings(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)); return;
            }
            startForegroundService(new Intent(this, SharingService.class).setAction("START"));
            handler.postDelayed(this::updateUi, 150);
        } catch (RuntimeException exception) { toast("无法启动共享，请检查蓝牙和后台运行权限"); }
    }

    private void chooseApps() {
        if (SharingService.running()) return;
        filter.setEnabled(false);
        background.execute(() -> {
            PackageManager manager = getPackageManager();
            Intent launch = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            Map<String, AppChoice> unique = new HashMap<>();
            for (ResolveInfo info : manager.queryIntentActivities(launch, 0)) {
                String pkg = info.activityInfo.packageName;
                if (!pkg.equals(getPackageName()))
                    unique.put(pkg, new AppChoice(pkg, Protocol.clip(info.loadLabel(manager), 80)));
            }
            // Keep prior selections even when a work-profile/package is not currently visible.
            for (String pkg : preferences.packages()) unique.putIfAbsent(pkg, new AppChoice(pkg, pkg));
            List<AppChoice> apps = new ArrayList<>(unique.values());
            apps.sort(Comparator.comparing(item -> item.label));
            handler.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                updateUi();
                if (SharingService.running()) return;
                String[] labels = new String[apps.size()];
                boolean[] checked = new boolean[apps.size()];
                Set<String> selected = preferences.packages();
                for (int i = 0; i < apps.size(); i++) {
                    labels[i] = apps.get(i).label + "\n" + apps.get(i).pkg;
                    checked[i] = selected.contains(apps.get(i).pkg);
                }
                new AlertDialog.Builder(this).setTitle("允许共享通知的应用")
                        .setMultiChoiceItems(labels, checked, (dialog, index, value) -> checked[index] = value)
                        .setNegativeButton("取消", null)
                        .setPositiveButton("保存", (dialog, which) -> {
                            if (SharingService.running()) return;
                            Set<String> result = new HashSet<>();
                            for (int i = 0; i < apps.size(); i++) if (checked[i]) result.add(apps.get(i).pkg);
                            preferences.packages(result);
                            updateUi();
                        }).show();
            });
        });
    }

    private void updateUi() {
        if (state == null) return;
        boolean running = SharingService.running();
        state.setText(SharingService.status());
        boolean access = NotificationRelay.hasAccess(this);
        boolean bluetooth = SharingService.bluetoothPermissions(this);
        String notification = Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ? " · 状态通知未授权（仍可在系统任务管理中停止）" : "";
        permissionState.setText("通知访问：" + (access ? "已授权" : "未授权")
                + " · 蓝牙：" + (bluetooth ? "已授权" : "未授权") + notification);
        nameOnly.setEnabled(!running);
        whitelist.setEnabled(!running);
        computers.setEnabled(!running && bluetooth);
        refresh.setEnabled(!running);
        discover.setEnabled(!running);
        filter.setEnabled(!running && preferences.whitelist());
        filterSummary.setText(preferences.whitelist() ? "已选择 " + preferences.packages().size() + " 个应用；未选择时不共享任何应用。"
                : "当前共享所有应用的普通通知。");
        share.setText(running ? "停止共享" : "开始共享");
    }

    private final Runnable refreshState = new Runnable() {
        @Override public void run() { updateUi(); handler.postDelayed(this, 750); }
    };

    @Override protected void onResume() {
        super.onResume();
        loadComputers();
        handler.removeCallbacks(refreshState);
        handler.post(refreshState);
    }
    @Override protected void onPause() { handler.removeCallbacks(refreshState); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); background.shutdownNow(); super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        loadComputers();
        updateUi();
        if (!SharingService.bluetoothPermissions(this))
            new AlertDialog.Builder(this).setMessage("未获得附近设备权限。若系统不再弹窗，请到本应用权限设置中开启。")
                    .setPositiveButton("打开设置", (dialog, which) -> openSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            android.net.Uri.parse("package:" + getPackageName())))).setNegativeButton("稍后", null).show();
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private static final class BondedChoice {
        final String address, label;
        BondedChoice(String address, String label) { this.address = address; this.label = label; }
        @Override public String toString() { return label; }
    }
    private static final class AppChoice {
        final String pkg, label;
        AppChoice(String pkg, String label) { this.pkg = pkg; this.label = label; }
    }
}
