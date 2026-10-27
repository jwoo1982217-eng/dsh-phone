package com.dshphone.browser;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Numeric-only viewport policy; browser identity must use the installed Chromium version. */
public final class BrowserProfilePolicy {
    private BrowserProfilePolicy() {}
    public static void validate(int width, int height, String identity) {
        if (width < 240 || width > 1920 || height < 240 || height > 2560)
            throw new IllegalArgumentException("网页视口范围：宽240–1920，高240–2560");
        if (!"android-real".equals(identity) && !"windows-desktop".equals(identity))
            throw new IllegalArgumentException("网页身份只能是手机或桌面");
    }
    public static int[] fit(int stageW, int stageH, int cssW, int cssH, double density) {
        validate(cssW,cssH,"android-real");
        if (stageW <= 0 || stageH <= 0 || !Double.isFinite(density) || density <= 0)
            throw new IllegalArgumentException("浏览器显示区域尚未就绪");
        double scale = Math.min(density,Math.min(stageW/(double)cssW,stageH/(double)cssH));
        int width = Math.max(1,(int)Math.round(cssW*scale)), height = Math.max(1,(int)Math.round(cssH*scale));
        return new int[]{(stageW-width)/2,(stageH-height)/2,width,height};
    }
    public static String chromeVersion(String ua) {
        Matcher match=Pattern.compile("(?:^|[ ])Chrome/([0-9]{1,4}\\.[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6})(?: |$)").matcher(ua == null ? "" : ua);
        if (!match.find()) throw new IllegalArgumentException("无法识别当前WebView版本，保留手机身份");
        return match.group(1);
    }
    public static String desktopUa(String ua) {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+chromeVersion(ua)+" Safari/537.36";
    }
    public static String viewportScript(int width) {
        validate(width,800,"android-real");
        return "(()=>{if(window.top!==window)return;const content='width="+width+", user-scalable=no';"
            +"const apply=()=>{const h=document.head;if(!h)return;let rows=[...document.querySelectorAll('meta[name=viewport]')];"
            +"if(!rows.length){const m=document.createElement('meta');m.name='viewport';h.appendChild(m);rows=[m]}"
            +"for(const m of rows)if(m.content!==content)m.content=content};apply();"
            +"const o=new MutationObserver(apply);o.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['content','name']});"
            +"setTimeout(()=>o.disconnect(),3000)})();";
    }
}
