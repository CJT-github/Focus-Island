//! WinRT BLE GATT client. Every COM operation runs on the MTA worker.
use super::*;
use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, SyncSender};
use ::windows::core::{Error, GUID};
use ::windows::Devices::Bluetooth::{BluetoothLEDevice, BluetoothAddressType, BluetoothCacheMode, BluetoothConnectionStatus};
use ::windows::Devices::Bluetooth::Advertisement::{BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcherStoppedEventArgs, BluetoothLEScanningMode};
use ::windows::Devices::Bluetooth::GenericAttributeProfile::{GattCharacteristic, GattDeviceService, GattValueChangedEventArgs, GattClientCharacteristicConfigurationDescriptorValue as Cccd, GattCommunicationStatus, GattProtectionLevel};
use ::windows::Foundation::TypedEventHandler;
use ::windows::Storage::Streams::DataReader;
use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

const SERVICE: GUID = GUID::from_u128(0x7b5e0001_6b7d_4a8f_9c10_6a2d3f4b5c60);
const NOTIFY: GUID = GUID::from_u128(0x7b5e0002_6b7d_4a8f_9c10_6a2d3f4b5c60);
#[derive(Debug)]
enum Failure { Cancelled, Permanent(String), Transient(String) }
fn api(error: Error) -> Failure { Failure::Transient(format!("蓝牙系统错误 0x{:08X}", error.code().0 as u32)) }
// WinRT connection requests themselves may finish late. Cancelling our wait,
// releasing all references and rejecting the old epoch prevents late delivery.
macro_rules! wait_operation {
    ($operation:expr, $shared:expr, $epoch:expr) => {{
        let operation = $operation.map_err(api)?;let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if !$shared.active($epoch) { let _ = operation.Cancel();return Err(Failure::Cancelled); }
            if operation.Status().map_err(api)?.0 != 0 { break operation.GetResults().map_err(api)?; }
            if Instant::now() >= deadline { let _ = operation.Cancel();return Err(Failure::Transient("蓝牙操作超时；请确认手机桥接服务仍在运行".into())); }
            std::thread::sleep(Duration::from_millis(25));
        }
    }};
}
enum TransportEvent {
    Found { epoch: u64, address: u64, address_type: BluetoothAddressType, name: String },
    ScanStopped { epoch: u64, code: i32 },
    Value { epoch: u64, link: u64, bytes: Vec<u8> },
}
struct Scan { watcher: BluetoothLEAdvertisementWatcher, received: i64, stopped: i64 }
impl Scan {
    fn new(epoch: u64, shared: Arc<Shared>, tx: SyncSender<TransportEvent>) -> Result<Self, Failure> {
        let watcher = BluetoothLEAdvertisementWatcher::new().map_err(api)?;
        watcher.SetScanningMode(BluetoothLEScanningMode::Active).map_err(api)?;
        watcher.AdvertisementFilter().map_err(api)?.Advertisement().map_err(api)?.ServiceUuids().map_err(api)?.Append(SERVICE).map_err(api)?;
        let received_tx=tx.clone();let received_shared=shared.clone();
        let received=watcher.Received(&TypedEventHandler::<BluetoothLEAdvertisementWatcher,BluetoothLEAdvertisementReceivedEventArgs>::new(move |_,args| {
            if !received_shared.active(epoch) { return Ok(()); }
            if let Some(args)=args.as_ref() {
                let address=args.BluetoothAddress()?;
                if address != 0 && address <= 0xffff_ffff_ffff {
                    let name=text(&args.Advertisement()?.LocalName()?.to_string(),80);
                    let _=received_tx.try_send(TransportEvent::Found{epoch,address,address_type:args.BluetoothAddressType().unwrap_or(BluetoothAddressType::Unspecified),name});
                }
            }
            Ok(())
        })).map_err(api)?;
        let stopped=match watcher.Stopped(&TypedEventHandler::<BluetoothLEAdvertisementWatcher,BluetoothLEAdvertisementWatcherStoppedEventArgs>::new(move |_,args| {
            if shared.active(epoch) { if let Some(args)=args.as_ref() { let _=tx.try_send(TransportEvent::ScanStopped{epoch,code:args.Error()?.0}); } }
            Ok(())
        })) { Ok(token)=>token,Err(error)=>{let _=watcher.RemoveReceived(received);return Err(api(error));} };
        let scan=Self{watcher,received,stopped};scan.watcher.Start().map_err(api)?;Ok(scan)
    }
}
impl Drop for Scan { fn drop(&mut self) { let _=self.watcher.RemoveReceived(self.received);let _=self.watcher.RemoveStopped(self.stopped);let _=self.watcher.Stop(); } }

struct Connection {
    device: BluetoothLEDevice,
    service: Option<GattDeviceService>,
    characteristic: Option<GattCharacteristic>,
    token: Option<i64>,
    opened: Instant,
    link: u64,
}
impl Connection {
    fn open(address: u64, address_type: Option<BluetoothAddressType>, epoch: u64, link: u64, shared: Arc<Shared>, tx: SyncSender<TransportEvent>) -> Result<Self, Failure> {
        let operation=match address_type {
            Some(kind) if kind!=BluetoothAddressType::Unspecified=>BluetoothLEDevice::FromBluetoothAddressWithBluetoothAddressTypeAsync(address,kind),
            _=>BluetoothLEDevice::FromBluetoothAddressAsync(address),
        };
        let device=wait_operation!(operation,shared,epoch);
        let mut connection=Self{device,service:None,characteristic:None,token:None,opened:Instant::now(),link};
        if !connection.device.DeviceInformation().map_err(api)?.Pairing().map_err(api)?.IsPaired().map_err(api)? {
            return Err(Failure::Permanent("请先在 Windows 蓝牙设置中配对并在手机确认，再点击连接".into()));
        }
        let services=wait_operation!(connection.device.GetGattServicesForUuidWithCacheModeAsync(SERVICE,BluetoothCacheMode::Uncached),shared,epoch);
        if services.Status().map_err(api)? != GattCommunicationStatus::Success { return Err(Failure::Transient("无法访问手机通知服务；请检查手机桥接开关和蓝牙连接".into())); }
        let services=services.Services().map_err(api)?;
        if services.Size().map_err(api)? != 1 { return Err(Failure::Transient("未发现手机通知服务；请打开 Android 桥接服务".into())); }
        connection.service=Some(services.GetAt(0).map_err(api)?);
        let characteristics=wait_operation!(connection.service.as_ref().unwrap().GetCharacteristicsForUuidWithCacheModeAsync(NOTIFY,BluetoothCacheMode::Uncached),shared,epoch);
        if characteristics.Status().map_err(api)? != GattCommunicationStatus::Success { return Err(Failure::Transient("无法读取手机通知特征".into())); }
        let characteristics=characteristics.Characteristics().map_err(api)?;
        if characteristics.Size().map_err(api)? != 1 { return Err(Failure::Permanent("手机通知特征不匹配，请更新桥接应用".into())); }
        let characteristic=characteristics.GetAt(0).map_err(api)?;
        characteristic.SetProtectionLevel(GattProtectionLevel::EncryptionRequired).map_err(api)?;
        connection.characteristic=Some(characteristic.clone());
        let event_shared=shared.clone();
        connection.token=Some(characteristic.ValueChanged(&TypedEventHandler::<GattCharacteristic,GattValueChangedEventArgs>::new(move |_,args| {
            if !event_shared.active(epoch) { return Ok(()); }
            if let Some(args)=args.as_ref() {
                let buffer=args.CharacteristicValue()?;let length=buffer.Length()? as usize;
                if length>8 && length<=MAX_MESSAGE_BYTES+8 {
                    let mut bytes=vec![0;length];DataReader::FromBuffer(&buffer)?.ReadBytes(&mut bytes)?;
                    let _=tx.try_send(TransportEvent::Value{epoch,link,bytes});
                }
            }
            Ok(())
        })).map_err(api)?);
        let result=wait_operation!(characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(Cccd::Notify),shared,epoch);
        if result != GattCommunicationStatus::Success { return Err(Failure::Transient("订阅手机通知失败；请确认系统已配对且手机允许连接".into())); }
        connection.opened=Instant::now();Ok(connection)
    }
    fn name(&self) -> String { self.device.Name().map(|name|text(&name.to_string(),80)).unwrap_or_default() }
    fn lost(&self) -> bool { self.opened.elapsed()>Duration::from_secs(1) && self.device.ConnectionStatus().map(|value|value!=BluetoothConnectionStatus::Connected).unwrap_or(true) }
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(characteristic)=&self.characteristic {
            if let Some(token)=self.token.take() { let _=characteristic.RemoveValueChanged(token); }
            if let Ok(operation)=characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(Cccd::None) {
                let deadline=Instant::now()+Duration::from_millis(250);
                while operation.Status().is_ok_and(|status|status.0==0) && Instant::now()<deadline { std::thread::sleep(Duration::from_millis(10)); }
                let _=operation.Cancel();
            }
        }
        if let Some(service)=&self.service { let _=service.Close(); }
        let _=self.device.Close();
    }
}
struct Apartment;
impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize(); } } }
fn phase(status: &mut PhoneStatus, shared: &Shared, value: &str, message: &str) {
    status.phase=value.into();status.message=message.into();shared.publish(status.clone());
}
pub(super) fn run(rx: Receiver<Request>, shared: Arc<Shared>) {
    let mut status=PhoneStatus::default();
    if let Err(error)=unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        phase(&mut status,&shared,"error",&format!("无法初始化 Windows 蓝牙服务（0x{:08X}）",error.code().0 as u32));return;
    }
    let _apartment=Apartment;
    let (events_tx,events_rx)=mpsc::sync_channel(128);
    let mut scan:Option<Scan>=None;let mut scan_until:Option<Instant>=None;
    let mut connection:Option<Connection>=None;let mut desired:Option<u64>=None;
    let mut next_attempt=Instant::now();let mut epoch=shared.epoch.load(Ordering::Acquire);
    let mut link=0_u64;let mut assembler=Assembler::default();let mut devices=BTreeMap::<u64,String>::new();
    let mut address_types=BTreeMap::<u64,BluetoothAddressType>::new();let mut recovery=ConnectionRecovery::default();
    loop {
        if shared.closed.load(Ordering::Acquire) { break; }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(request)=>{
                if matches!(request.kind,RequestKind::Shutdown) { break; }
                if request.epoch != shared.epoch.load(Ordering::Acquire) { continue; }
                if request.epoch != epoch {
                    connection=None;scan=None;scan_until=None;desired=None;assembler=Assembler::default();epoch=request.epoch;
                    status.notification_access=None;recovery=ConnectionRecovery::default();
                }
                match request.kind {
                    RequestKind::Configure(false)|RequestKind::Disconnect=>{
                        connection=None;scan=None;scan_until=None;desired=None;assembler=Assembler::default();
                        status.device_name.clear();status.device_address.clear();status.notification_access=None;
                        if shared.enabled.load(Ordering::Acquire) { phase(&mut status,&shared,"idle","已断开手机连接"); }
                        else { devices.clear();address_types.clear();status.devices.clear();phase(&mut status,&shared,"disabled","手机通知已关闭"); }
                    }
                    RequestKind::Configure(true)=>{phase(&mut status,&shared,"idle","请打开 Android 桥接服务并扫描手机");}
                    RequestKind::Scan if shared.active(epoch)=>{
                        scan=None;devices.clear();address_types.clear();status.devices.clear();
                        match Scan::new(epoch,shared.clone(),events_tx.clone()) {
                            Ok(watcher)=>{scan=Some(watcher);scan_until=Some(Instant::now()+Duration::from_secs(20));phase(&mut status,&shared,if connection.is_some(){"connected"}else{"scanning"},"正在扫描附近的手机通知服务…");}
                            Err(error)=>{let message=match error {Failure::Permanent(message)|Failure::Transient(message)=>message,Failure::Cancelled=>"扫描已取消".into()};phase(&mut status,&shared,if connection.is_some(){"connected"}else{"error"},&message);}
                        }
                    }
                    RequestKind::Connect(address) if shared.active(epoch)=>{
                        if address==0 || address>0xffff_ffff_ffff { phase(&mut status,&shared,"error","无效的蓝牙设备地址");continue; }
                        scan=None;scan_until=None;desired=Some(address);recovery=ConnectionRecovery::default();next_attempt=Instant::now();
                        status.device_address=address.to_string();status.device_name=devices.get(&address).cloned().unwrap_or_default();
                        phase(&mut status,&shared,"connecting","正在连接已选择的手机…");
                    }
                    _=>{}
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected)=>break,
            Err(mpsc::RecvTimeoutError::Timeout)=>{}
        }
        if !shared.active(epoch) { while events_rx.try_recv().is_ok() {} continue; }
        for _ in 0..128 {
            let Ok(event)=events_rx.try_recv() else { break; };
            match event {
                TransportEvent::Found{epoch:event_epoch,address,address_type,name} if event_epoch==epoch&&scan.is_some()=>{
                    if devices.len()<64 || devices.contains_key(&address) {
                        address_types.insert(address,address_type);
                        let name=if name.trim().is_empty(){"Android 手机".into()}else{name};
                        if devices.get(&address)!=Some(&name) {
                            devices.insert(address,name);status.devices=devices.iter().map(|(address,name)|PhoneDevice{address:address.to_string(),name:name.clone()}).collect();shared.publish(status.clone());
                        }
                    }
                }
                TransportEvent::ScanStopped{epoch:event_epoch,code} if event_epoch==epoch&&scan.is_some()&&code!=0=>{
                    scan=None;scan_until=None;phase(&mut status,&shared,"error",&format!("蓝牙扫描已停止（错误 {}），请检查适配器和系统蓝牙开关",code));
                }
                TransportEvent::Value{epoch:event_epoch,link:event_link,bytes} if event_epoch==epoch&&connection.as_ref().is_some_and(|value|value.link==event_link)=>{
                    if let Ok(Some(value))=assembler.push(&bytes,Instant::now()) {
                        match value {
                            DecodedMessage::Notification(notification)=>{if status.notification_access==Some(true){shared.notification(epoch,notification);}},
                            DecodedMessage::Status{notification_access,name}=>{
                                recovery.confirmed();status.notification_access=Some(notification_access);if !notification_access{assembler=Assembler::default();}if !name.trim().is_empty(){status.device_name=name;}
                                phase(&mut status,&shared,"connected",if notification_access{"已连接，正在接收手机通知"}else{"已连接；请在手机上允许通知读取权限"});
                            }
                        }
                    }
                }
                _=>{}
            }
        }
        if scan_until.is_some_and(|deadline|Instant::now()>=deadline) {
            scan=None;scan_until=None;
            if connection.is_some(){phase(&mut status,&shared,"connected","扫描完成，手机连接保持");}
            else if desired.is_none(){phase(&mut status,&shared,"idle",if devices.is_empty(){"未发现通知服务，请确认手机桥接已开启且蓝牙可用"}else{"扫描完成，请选择已在系统配对的手机"});}
        }
        if connection.is_some() && recovery.expired(Instant::now()) {
            connection=None;assembler=Assembler::default();status.notification_access=None;
            if recovery.failed() {
                next_attempt=Instant::now()+Duration::from_secs(3);phase(&mut status,&shared,"reconnecting","10 秒内未收到手机状态确认，正在重新连接…");
            } else {
                desired=None;phase(&mut status,&shared,"error","连续三次未能确认手机通知状态，请重新扫描手机并检查桥接服务");
            }
        }
        if connection.as_ref().is_some_and(Connection::lost) {
            connection=None;assembler=Assembler::default();status.notification_access=None;
            // A connection lost before status confirmation consumes an attempt;
            // a previously confirmed link starts its normal reconnection budget.
            if recovery.waiting() && !recovery.failed() {
                desired=None;phase(&mut status,&shared,"error","连续三次在状态确认前断开，请重新扫描并选择手机");
            } else {
                next_attempt=Instant::now()+Duration::from_secs(3);phase(&mut status,&shared,"reconnecting","手机连接已断开，正在等待重连…");
            }
        }
        if connection.is_none() && Instant::now()>=next_attempt {
            if let Some(address)=desired {
                link=link.wrapping_add(1);let result=Connection::open(address,address_types.get(&address).copied(),epoch,link,shared.clone(),events_tx.clone());
                if !shared.active(epoch){drop(result);continue;}
                match result {
                    Ok(value)=>{recovery.subscribed(Instant::now());let name=value.name();if !name.is_empty(){status.device_name=name;}connection=Some(value);assembler=Assembler::default();phase(&mut status,&shared,"connected","已连接，等待手机通知权限状态…");}
                    Err(Failure::Cancelled)=>{},
                    Err(Failure::Permanent(message))=>{desired=None;phase(&mut status,&shared,"error",&message);}
                    Err(Failure::Transient(message))=>{
                        if !recovery.failed() { desired=None;phase(&mut status,&shared,"error",&format!("{}；请重新扫描并选择手机（手机蓝牙地址可能已变化）",message)); }
                        else {next_attempt=Instant::now()+Duration::from_secs(5);phase(&mut status,&shared,"reconnecting",&format!("{}；稍后重试，可随时断开",message));}
                    }
                }
            }
        }
    }
    drop(connection);drop(scan);
}
