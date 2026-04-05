declare module "openclaw/plugin-sdk" {
  export type PluginCommandContext = {
    args?: string;
    sessionKey?: string;
    [key: string]: unknown;
  };

  export type OpenClawPluginCommandDefinition = {
    name: string;
    nativeNames?: { default?: string };
    description: string;
    acceptsArgs?: boolean;
    handler: (
      ctx: PluginCommandContext,
    ) => Promise<{ text: string }> | { text: string };
  };
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry<T>(entry: T): T;
}
