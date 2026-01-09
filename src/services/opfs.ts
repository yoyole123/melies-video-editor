export class OpfsService {
  private root: FileSystemDirectoryHandle | null = null;

  async init() {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
  }

  async saveFile(filename: string, blob: Blob): Promise<string> {
    await this.init();
    const fileHandle = await this.root!.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return filename; // For OPFS, the filename is the key
  }

  async getFile(filename: string): Promise<File | null> {
    try {
      await this.init();
      const fileHandle = await this.root!.getFileHandle(filename);
      return await fileHandle.getFile();
    } catch (e) {
      return null;
    }
  }

  async getUrl(filename: string): Promise<string | null> {
    const file = await this.getFile(filename);
    if (!file) return null;
    return URL.createObjectURL(file);
  }

  async exists(filename: string): Promise<boolean> {
    try {
      await this.init();
      await this.root!.getFileHandle(filename);
      return true;
    } catch {
      return false;
    }
  }
}

export const opfs = new OpfsService();
