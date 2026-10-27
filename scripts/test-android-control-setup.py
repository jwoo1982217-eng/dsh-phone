"""Test the production fixed repair Binder in a disposable Android package, without restarting DSH."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
JAVA = r'''
package com.dshphone.control;
import android.content.*;
import android.content.pm.ApplicationInfo;
import android.os.*;
import org.json.JSONObject;
public class RepairFixtureMain {
  static String command(String... args) throws Exception {
    java.lang.Process p=new ProcessBuilder(args).redirectErrorStream(true).start();
    if(!p.waitFor(4,java.util.concurrent.TimeUnit.SECONDS))throw new Exception("fixture command timeout");
    String out=new String(p.getInputStream().readAllBytes()).trim();
    if(p.exitValue()!=0)throw new Exception("fixture command rejected");return out;
  }
  static JSONObject call(ControlRepairService service,boolean extra) throws Exception {return call(service,extra,ControlRepairService.REPAIR);}
  static JSONObject call(ControlRepairService service,boolean extra,int operation) throws Exception {
    Parcel data=Parcel.obtain(),reply=Parcel.obtain();
    try {data.writeInterfaceToken(ControlRepairService.DESCRIPTOR);if(extra)data.writeString("forbidden target");
      service.transact(operation,data,reply,0);reply.readException();return new JSONObject(reply.readString());
    } finally {data.recycle();reply.recycle();}
  }
  static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  public static void main(String[] args){try{System.out.println(exercise(args).toString());System.exit(0);}catch(Throwable error){error.printStackTrace();System.exit(2);}}
  static JSONObject exercise(String[] args) throws Exception {
    final String pkg=args[0];check(pkg.matches("com\\.dshphone\\.controlsetupfixture\\.t[a-f0-9]+"),"fixture target only");
    Context target=new ContextWrapper(null){public String getPackageName(){return pkg;}public ApplicationInfo getApplicationInfo(){ApplicationInfo info=new ApplicationInfo();info.uid=android.os.Process.myUid();return info;}};
    String before=command("settings","get","secure","enabled_accessibility_services");
    ControlRepairService service=new ControlRepairService(target);
    JSONObject first=call(service,false,ControlRepairService.RECONNECT),second=call(service,false,ControlRepairService.RECONNECT);
    String after=command("settings","get","secure","enabled_accessibility_services");
    for(String old:before.split(":"))if(!old.isBlank()&&!old.equals("null"))check(java.util.Arrays.asList(after.split(":")).contains(old),"unrelated service removed");
    String own=pkg+"/com.dshphone.control.PhoneControlService";
    check(java.util.Arrays.stream(after.split(":")).filter(x->x.equals(own)).count()==1,"own service must occur once");
    boolean extraDenied=false,foreignDenied=false;
    try{call(service,true);}catch(IllegalArgumentException e){extraDenied=true;}
    Context wrongOwner=new ContextWrapper(target){public ApplicationInfo getApplicationInfo(){ApplicationInfo info=new ApplicationInfo(super.getApplicationInfo());info.uid++;return info;}};
    try{call(new ControlRepairService(wrongOwner),false);}catch(IllegalStateException e){foreignDenied="只允许本应用恢复自己的控制通道".equals(e.getMessage());}
    check(extraDenied&&foreignDenied,"Binder must reject extra data and another UID");
    check(after.equals(command("settings","get","secure","enabled_accessibility_services")),"rejected requests changed settings");
    check(first.getBoolean("settingsAccepted")&&second.getBoolean("otherServicesPreserved"),"repair not accepted");
    command("settings","put","secure","enabled_accessibility_services",before.equals("null")?"":before);
    boolean manualCloseRespected=false;
    try{call(service,false,ControlRepairService.RECONNECT);}catch(IllegalStateException e){manualCloseRespected=e.getMessage().contains("已被关闭");}
    check(manualCloseRespected,"automatic reconnect must respect a manual close");
    check(command("settings","get","secure","enabled_accessibility_services").equals(before),"manual close was overwritten");
    check(call(service,false).getBoolean("settingsAccepted"),"explicit setup must recover after close");
    return new JSONObject().put("passed",true).put("realAndroidSettingsAccepted",true).put("realShellRepairBinder",true).put("realShizukuUserService",false).put("otherServicesPreserved",true).put("repeatDidNotDuplicate",true).put("extraArgumentsDenied",true).put("foreignUidDenied",true).put("rejectedRequestsChangedNothing",true).put("manualCloseRespected",true).put("explicitSetupRecoveredAfterClose",true);
  }
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    project = output / 'project'; sources = project / 'app/src/main/java/com/dshphone/control'
    sources.mkdir(parents=True, exist_ok=True)
    package = 'com.dshphone.controlsetupfixture.t' + uuid.uuid4().hex[:10]
    component = package + '/com.dshphone.control.PhoneControlService'
    adb = ['adb', '-P', '5037', '-s', args.serial]
    def shell(*parts):
        return subprocess.check_output([*adb, 'shell', shlex.join(parts)], text=True, timeout=15).strip()
    for name in ['build.gradle', 'settings.gradle', 'gradle.properties']:
        shutil.copy2(ROOT / name, project / name)
    (project / 'local.properties').write_text('sdk.dir=/Users/example/Library/Android/sdk\n')
    service = ROOT / 'app/src/main/java/com/dshphone/control/ControlRepairService.kt'
    shutil.copy2(service, sources / service.name)
    (sources / 'RepairFixtureInstrumentation.java').unlink(missing_ok=True)
    (sources / 'RepairFixtureMain.java').write_text(JAVA)
    (sources / 'FixtureActivity.java').write_text('package com.dshphone.control; public class FixtureActivity extends android.app.Activity {}')
    shutil.copy2(ROOT / 'app/src/main/java/com/dshphone/control/ControlRepair.kt', sources / 'ControlRepair.kt')
    (sources / 'FixtureRuntime.kt').write_text('''package com.dshphone.control
object ControlRuntime { var service: PhoneControlService? = null }
object AppLogs { fun status() = org.json.JSONObject().put("available", rikka.shizuku.Shizuku.pingBinder() && rikka.shizuku.Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED) }
''')
    (sources / 'PhoneControlService.java').write_text('package com.dshphone.control; public class PhoneControlService extends android.accessibilityservice.AccessibilityService { public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent e){} public void onInterrupt(){} }')
    resources = project / 'app/src/main/res/xml'; resources.mkdir(parents=True, exist_ok=True)
    (resources / 'control.xml').write_text('<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android" android:accessibilityEventTypes="typeWindowStateChanged" android:accessibilityFeedbackType="feedbackGeneric" android:canRetrieveWindowContent="false" android:canPerformGestures="false"/>')
    (project / 'app/build.gradle').write_text("plugins { id 'com.android.application' }\nandroid { namespace 'com.dshphone.control'; compileSdk 36\n defaultConfig { applicationId '" + package + "'; minSdk 28; targetSdk 36; versionCode 1; versionName 'test' }\n compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }\n}\ndependencies { implementation 'dev.rikka.shizuku:api:13.1.5'; implementation 'dev.rikka.shizuku:provider:13.1.5' }\n")
    (project / 'app/src/main/AndroidManifest.xml').write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="moe.shizuku.manager.permission.API_V23"/><application android:allowBackup="false" android:label="DSH control setup verification"><activity android:name="com.dshphone.control.FixtureActivity" android:exported="false"/><provider android:name="rikka.shizuku.ShizukuProvider" android:authorities="${applicationId}.shizuku" android:exported="true" android:multiprocess="false" android:permission="android.permission.INTERACT_ACROSS_USERS_FULL"/><service android:name="com.dshphone.control.PhoneControlService" android:exported="true" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"><intent-filter><action android:name="android.accessibilityservice.AccessibilityService"/></intent-filter><meta-data android:name="android.accessibilityservice" android:resource="@xml/control"/></service></application><instrumentation android:name="com.dshphone.control.RepairFixtureInstrumentation" android:targetPackage="' + package + '"/></manifest>')
    with (output / 'build.log').open('w') as log:
        subprocess.run([str(ROOT / 'gradlew'), '--offline', '--no-daemon', '--max-workers=2', '--no-parallel', ':app:assembleDebug'], cwd=project, stdout=log, stderr=subprocess.STDOUT, check=True)
    original = shell('settings', 'get', 'secure', 'enabled_accessibility_services')
    enabled = shell('settings', 'get', 'secure', 'accessibility_enabled')
    receipt = {'package': package, 'productionPidBefore': shell('pidof', 'com.dshphone'), 'sourceSha256': hashlib.sha256(service.read_bytes()).hexdigest()}
    installed = False
    try:
        existing = subprocess.run([*adb, 'shell', 'pm', 'path', package], capture_output=True, text=True, timeout=10)
        assert existing.returncode in (0, 1) and not existing.stdout.strip(), 'Refuse to replace existing package'
        subprocess.run([*adb, 'install', str(project / 'app/build/outputs/apk/debug/app-debug.apk')], capture_output=True, check=True); installed = True
        shell('cmd', 'appops', 'set', package, 'ACCESS_RESTRICTED_SETTINGS', 'ignore')
        apk = shell('pm', 'path', package).removeprefix('package:')
        command = 'CLASSPATH=' + shlex.quote(apk) + ' app_process /system/bin com.dshphone.control.RepairFixtureMain ' + shlex.quote(package)
        run = subprocess.run([*adb, 'shell', command], capture_output=True, text=True, timeout=50)
        (output / 'device.log').write_text(run.stdout + run.stderr)
        reports = [json.loads(line[line.index('{'):]) for line in run.stdout.splitlines() if '{"passed"' in line]
        if reports: receipt.update(reports[-1])
        assert run.returncode == 0 and receipt.get('passed'), 'Real Android fixture failed; see device.log'
    finally:
        if installed:
            current = shell('settings', 'get', 'secure', 'enabled_accessibility_services')
            keep = [s for s in current.split(':') if s and s != 'null' and s != component]
            shell('settings', 'put', 'secure', 'enabled_accessibility_services', ':'.join(keep))
            if not keep and enabled != '1': shell('settings', 'put', 'secure', 'accessibility_enabled', enabled if enabled in ['0', '1'] else '0')
            receipt['fixtureRemoved'] = 'Success' in subprocess.check_output([*adb, 'uninstall', package], text=True)
        final = shell('settings', 'get', 'secure', 'enabled_accessibility_services')
        receipt['originalServicesRetained'] = all(s in final.split(':') for s in original.split(':') if s and s != 'null')
        receipt['productionPidAfter'] = shell('pidof', 'com.dshphone')
        receipt['productionNotRestarted'] = receipt['productionPidBefore'] == receipt['productionPidAfter']
        (output / 'verification.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(receipt, ensure_ascii=False))

if __name__ == '__main__': main()
