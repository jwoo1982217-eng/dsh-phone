package com.dshphone.virtualscreen;
/** Pure contracts shared by the native viewer and the session control path. */
public final class VirtualScreenPolicy {
    private VirtualScreenPolicy() { }
    private static void valid(boolean condition) { if (!condition) throw new IllegalArgumentException("Invalid virtual-screen target or coordinates"); }
    public static void requireOwned(String alias, int id) { valid("virtual-1".equals(alias) && id > 0); }
    private static void position(int width,int height,double x,double y) {
        valid(width > 0 && height > 0 && Double.isFinite(x) && Double.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height);
    }
    public static String[] tap(int id,int width,int height,double x,double y) {
        requireOwned("virtual-1",id); position(width,height,x,y);
        return new String[]{"/system/bin/input","-d",Integer.toString(id),"tap",Integer.toString((int)x),Integer.toString((int)y)};
    }
    public static String[] swipe(int id,int width,int height,double x,double y,double ex,double ey,int millis) {
        requireOwned("virtual-1",id); position(width,height,x,y); position(width,height,ex,ey); valid(millis >= 50 && millis <= 2000);
        return new String[]{"/system/bin/input","-d",Integer.toString(id),"swipe",Integer.toString((int)x),Integer.toString((int)y),Integer.toString((int)ex),Integer.toString((int)ey),Integer.toString(millis)};
    }
    public static String[] back(int id) { requireOwned("virtual-1",id); return new String[]{"/system/bin/input","-d",Integer.toString(id),"keyevent","4"}; }
    private static void packageName(String pkg) { valid(pkg != null && pkg.matches("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+")); }
    public static String[] launch(int id,int user,String pkg,String component) {
        requireOwned("virtual-1",id); packageName(pkg); valid(user >= 0);
        valid(component != null && component.matches("[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+") && component.startsWith(pkg + "/"));
        return new String[]{"/system/bin/am","start","--user",Integer.toString(user),"--display",Integer.toString(id),"-n",component};
    }
    public static String[] resolveActivity(int user,String pkg) {
        packageName(pkg); valid(user >= 0);
        return new String[]{"/system/bin/cmd","package","resolve-activity","--brief","--user",Integer.toString(user),"-a","android.intent.action.MAIN","-c","android.intent.category.LAUNCHER",pkg};
    }
    public static int[] fit(int vw,int vh,int width,int height) {
        valid(vw > 0 && vh > 0 && width > 0 && height > 0);
        double scale=Math.min((double)vw/width,(double)vh/height);
        int w=Math.max(1,(int)Math.floor(width*scale)),h=Math.max(1,(int)Math.floor(height*scale));
        return new int[]{(vw-w)/2,(vh-h)/2,w,h};
    }
    public static int[] point(double x,double y,int vw,int vh,int width,int height) {
        int[] r=fit(vw,vh,width,height);
        valid(Double.isFinite(x) && Double.isFinite(y) && x >= r[0] && y >= r[1] && x < r[0]+r[2] && y < r[1]+r[3]);
        return new int[]{Math.min(width-1,(int)((x-r[0])*width/r[2])),Math.min(height-1,(int)((y-r[1])*height/r[3]))};
    }
    public static final class Snapshot {
        public final String owner,nonce;
        public final int id,width,height;
        public final long generation,at;
        public Snapshot(String owner,String nonce,int id,int width,int height,long generation,long at) {
            requireOwned("virtual-1",id); valid(owner != null && nonce != null && width > 0 && height > 0);
            this.owner=owner;this.nonce=nonce;this.id=id;this.width=width;this.height=height;this.generation=generation;this.at=at;
        }
        public boolean matches(String owner,String nonce,int id,long generation,long at) {
            return this.owner.equals(owner) && this.nonce.equals(nonce) && this.id==id && this.generation==generation && at>=this.at && at-this.at<30000;
        }
    }
}
