export interface ArchiveEntry {
  dir: string;
  flavor: string;
  version: string;
  dateRaw: string;
  dateFormatted: string;
  platforms: ("android" | "ios")[];
  hasSource: boolean;
  androidSymbols: boolean;
  iosSymbols: boolean;
  sourceSizeMB: string;
  androidSizeMB: string;
  iosSizeMB: string;
  releaseNotes: string;
}
