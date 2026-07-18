/**
 * pluginRegistry.ts — central registry of all available pipeline plugins.
 *
 * ─── PLUGIN LIFECYCLE ────────────────────────────────────────────────────────
 *
 *  BUILT-IN plugins (bundled at build time):
 *    1. Create a new file in app/components/plugins/ implementing Plugin<YourParams>.
 *    2. Import it here and add it to the BUILTIN_PLUGINS array.
 *    PipelineBlock requires NO changes for new built-in plugins.
 *
 *  USER-UPLOADED plugins (local, ephemeral, sandboxed):
 *    1. User picks a compiled .js plugin file via the Upload Plugin UI.
 *    2. loadUserPlugin(file) dynamically imports it inside a try/catch.
 *       If the module throws at load time, it is rejected cleanly.
 *    3. registerPlugin() validates it and adds it to _runtimePlugins.
 *    4. The plugin id is persisted to localStorage so it survives refresh
 *       (the file itself is re-requested; persistence is id-only).
 *    5. removeUserPlugin(id) unregisters and removes from localStorage.
 *    All computation runs locally — no data ever leaves the browser.
 *
 *  APPROVED plugins (future registry/marketplace):
 *    • A JSON/YAML registry serves approved PluginManifest[] entries.
 *    • The UI shows an "Install" button per manifest.
 *    • Clicking install loads the plugin via its registry moduleUrl.
 *    • Approved plugins are available to all users.
 */
import { Plugin } from '../../lib/pluginTypes';
import { sinlPlugin }        from './sinlPlugin';        // signal: Sine INL/DNL
import { smeasPlugin }       from './smeasPlugin';       // signal: FFT Spectrum
import { hsioalphaPlugin }        from './hsioalphaPlugin';        // signal: HSIO Eye Diagram
// import { hsioPlugin }        from './hsioPlugin';        // signal: HSIO Eye & Jitter
// import { minimalPlugin }     from './minimalPlugin';     // template: bare minimum
// import { minimalPlotPlugin } from './minimalPlotPlugin'; // template: minimum + figure

// const BUILTIN_PLUGINS: Plugin<any>[] = [sinlPlugin, smeasPlugin, hsioPlugin, minimalPlugin, minimalPlotPlugin]; // eslint-disable-line @typescript-eslint/no-explicit-any
// const BUILTIN_PLUGINS: Plugin<any>[] = [sinlPlugin, smeasPlugin, minimalPlugin, minimalPlotPlugin]; // eslint-disable-line @typescript-eslint/no-explicit-any
const BUILTIN_PLUGINS: Plugin<any>[] = [sinlPlugin, smeasPlugin, hsioalphaPlugin]; // eslint-disable-line @typescript-eslint/no-explicit-any

// Runtime-registered plugins (user-uploaded or future marketplace installs)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _runtimePlugins: Plugin<any>[] = [];

const USER_PLUGIN_IDS_KEY = 'userPluginIds';

/** All currently available plugins (built-in + runtime registered). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PLUGINS: Plugin<any>[] = new Proxy([] as Plugin<any>[], {
  get(_, prop) {
    const combined = [...BUILTIN_PLUGINS, ..._runtimePlugins];
    if (prop === 'length') return combined.length;
    if (prop === Symbol.iterator) return combined[Symbol.iterator].bind(combined);
    if (typeof prop === 'string' && !isNaN(Number(prop))) return combined[Number(prop)];
    if (prop in combined) {
      const val = (combined as any)[prop]; // eslint-disable-line @typescript-eslint/no-explicit-any
      return typeof val === 'function' ? val.bind(combined) : val;
    }
    return undefined;
  },
});

/** Register a new plugin at runtime. Validates for param conflicts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPlugin(plugin: Plugin<any>): void {
  if (_runtimePlugins.find(p => p.id === plugin.id)) return; // idempotent

  const configKeys = Object.keys(plugin.defaultParams ?? {});
  const paramFieldKeys = (plugin.paramFields ?? plugin.inferredParamFields ?? []).map(f => f.key);
  const conflicts = configKeys.filter(k => paramFieldKeys.includes(k));

  if (conflicts.length > 0) {
    throw new Error(
      `Plugin "${plugin.id}" registration failed: Parameter conflict detected!\n\n` +
      `Keys [${conflicts.join(', ')}] are defined in BOTH:\n` +
      `  • defaultParams (pure global — shared across all files)\n` +
      `  • paramFields (malleable — can be toggled global ↔ per-file)\n\n` +
      `Fix: Remove [${conflicts.join(', ')}] from either defaultParams or paramFields.`
    );
  }

  _runtimePlugins.push(plugin);
}

/**
 * Load a user-supplied compiled plugin file (.js) dynamically.
 *
 * The entire import is wrapped in try/catch — a broken plugin cannot crash the
 * site. The module must export a default or named export that satisfies Plugin<P>.
 *
 * On success, the plugin is registered and its id is persisted to localStorage
 * so it appears as "user plugin" in the UI across refreshes.
 *
 * @param file   A .js file selected by the user (compiled from their plugin .tsx)
 * @returns      { ok: true, plugin } | { ok: false, error: string }
 */
export async function loadUserPlugin(
  file: File,
): Promise<{ ok: true; plugin: Plugin<any> } | { ok: false; error: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    // If the file is TypeScript/TSX source, compile it server-side first.
    // Plain .js files are loaded directly without a round-trip.
    const isSource = /\.(tsx?|jsx)$/.test(file.name);
    let url: string;

    if (isSource) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/compile-plugin', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        return { ok: false, error: `Server compilation failed: ${body.error ?? res.statusText}` };
      }
      const compiledJs = await res.text();
      const blob = new Blob([compiledJs], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);
    } else if (file.name.endsWith('.js')) {
      url = URL.createObjectURL(file);
    } else {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : 'unknown';
      return {
        ok: false,
        error: `Unsupported file type ".${ext}". Upload a .tsx, .ts, or .js plugin file.`,
      };
    }

    let mod: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      mod = await import(/* webpackIgnore: true */ url);
    } finally {
      URL.revokeObjectURL(url);
    }

    // The plugin can be the default export or any named export that looks like a Plugin
    const candidates = [
      mod.default,
      ...Object.values(mod),
    ].filter(
      (v): v is Plugin<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
        v !== null &&
        typeof v === 'object' &&
        typeof (v as any).id === 'string' && // eslint-disable-line @typescript-eslint/no-explicit-any
        typeof (v as any).run === 'function', // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    if (candidates.length === 0) {
      return { ok: false, error: 'No valid plugin export found. The file must export an object with { id, run, defaultParams }.' };
    }

    const plugin = candidates[0];

    // Check for id collision with built-ins
    if (BUILTIN_PLUGINS.find(p => p.id === plugin.id)) {
      return {
        ok: false,
        error: `Plugin id "${plugin.id}" is already registered as a built-in plugin. ` +
               `This plugin ships with the platform and cannot be overridden by upload. ` +
               `If you are developing a modified version, change the plugin's id field to a unique value.`,
      };
    }

    registerPlugin(plugin); // throws if param conflicts detected

    // Persist id to localStorage (file itself is not persisted — only the id label)
    try {
      const stored = JSON.parse(localStorage.getItem(USER_PLUGIN_IDS_KEY) ?? '[]') as string[];
      if (!stored.includes(plugin.id)) {
        localStorage.setItem(USER_PLUGIN_IDS_KEY, JSON.stringify([...stored, plugin.id]));
      }
    } catch { /* localStorage unavailable — silent */ }

    return { ok: true, plugin };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Plugin load failed: ${msg}` };
  }
}

/** Returns the ids of user-uploaded plugins persisted in localStorage. */
export function getUserPluginIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(USER_PLUGIN_IDS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Unregister a runtime plugin by id and remove from localStorage. */
export function unregisterPlugin(id: string): void {
  const idx = _runtimePlugins.findIndex(p => p.id === id);
  if (idx !== -1) _runtimePlugins.splice(idx, 1);
  try {
    const stored = JSON.parse(localStorage.getItem(USER_PLUGIN_IDS_KEY) ?? '[]') as string[];
    localStorage.setItem(USER_PLUGIN_IDS_KEY, JSON.stringify(stored.filter(i => i !== id)));
  } catch { /* silent */ }
}
