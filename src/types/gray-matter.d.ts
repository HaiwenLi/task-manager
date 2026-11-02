declare module "gray-matter" {
  /** Subset of gray-matter's API used by taskctl (package ships no types). */
  export interface GrayMatterFile {
    data: Record<string, unknown>;
    content: string;
    excerpt?: string;
    matter?: string;
    isEmpty?: boolean;
  }
  export interface GrayMatterOptions {
    delimiters?: string | [string, string];
    excerpt?: boolean;
    language?: string;
  }
  export default function matter(input: string, options?: GrayMatterOptions): GrayMatterFile;
}
