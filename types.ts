export type CScriptScript = {
  description: string;
  help: string;
  run: (args: string[]) => void | Promise<void>;
  complete?: (args: string[]) => string[] | Promise<string[]>;
};
