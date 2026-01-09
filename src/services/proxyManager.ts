import { opfs } from './opfs';
import { transcoder } from './transcoder';

export interface ProxyStatus {
  originalSaved: boolean;
  proxySaved: boolean;
  proxyUrl?: string;
}

export class ProxyManager {
  /**
   * Ensures a file has a proxy in OPFS.
   * 1. Saves original to OPFS (if not exists)
   * 2. Checks if proxy exists in OPFS
   * 3. If not, generates proxy and saves to OPFS
   * 4. Returns the Blob URL of the proxy
   */
  async ensureProxy(file: File, onProgress: (msg: string, pct: number) => void): Promise<string> {
    const originalName = 'orig_' + file.name;
    const proxyName = 'proxy_' + file.name + '.mp4'; // force mp4 extension for proxies

    // 1. Save Original
    const hasOriginal = await opfs.exists(originalName);
    if (!hasOriginal) {
      onProgress('Saving original...', 0);
      await opfs.saveFile(originalName, file);
    }

    // 2. Check Proxy
    const hasProxy = await opfs.exists(proxyName);
    if (hasProxy) {
      onProgress('Loading proxy...', 1);
      return (await opfs.getUrl(proxyName))!;
    }

    // 3. Generate Proxy
    onProgress('Transcoding proxy...', 0);
    const proxyBlob = await transcoder.generateProxy(file, (p) => {
      onProgress('Transcoding...', p);
    });

    // 4. Save Proxy
    onProgress('Saving proxy...', 0.9);
    await opfs.saveFile(proxyName, proxyBlob);

    onProgress('Done', 1);
    return (await opfs.getUrl(proxyName))!;
  }

  /**
   * Returns the Original File from OPFS (for export)
   */
  async getOriginalFile(filename: string): Promise<File | null> {
    const originalName = 'orig_' + filename;
    return await opfs.getFile(originalName);
  }
}

export const proxyManager = new ProxyManager();
