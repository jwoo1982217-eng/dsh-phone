export declare const BUNDLED_NOEMA_COMMAND = "bundled";
export interface NoemaPlatformPackage {
    packageName: string;
    rustTarget: string;
    binaryName: string;
}
export declare const NOEMA_PLATFORM_PACKAGES: Readonly<Record<string, NoemaPlatformPackage>>;
export interface BundledNoemaResolutionOptions {
    platform?: string;
    arch?: string;
    projectRoot?: string;
    resolvePackageJson?: (specifier: string) => string;
    isFile?: (path: string) => boolean;
}
/** Stable npm selector key for the current Node platform and architecture. */
export declare function noemaPlatformKey(platform?: string, arch?: string): string;
/** Platform descriptor, or undefined when this release family has no binary. */
export declare function noemaPlatformPackage(platform?: string, arch?: string): NoemaPlatformPackage | undefined;
/**
 * Ordered candidates: release/debug builds from the git submodule first, then
 * the installed optional package. Exposed to make packaging tests deterministic.
 */
export declare function bundledNoemaCandidates(options?: BundledNoemaResolutionOptions): string[];
/** Resolve the bundled executable if an installed package or dev build exists. */
export declare function tryResolveBundledNoemaBinary(options?: BundledNoemaResolutionOptions): string | undefined;
/** Resolve the bundled executable or fail with a platform-specific remedy. */
export declare function resolveBundledNoemaBinary(options?: BundledNoemaResolutionOptions): string;
