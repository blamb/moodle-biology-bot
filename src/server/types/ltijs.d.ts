// Minimal hand-written types for ltijs (5.x) and ltijs-sequelize.
// The published package ships no TypeScript definitions, so we declare only
// the surface we actually use. Expand as needed.

declare module 'ltijs' {
  import type { Express, Request, Response, NextFunction } from 'express';

  export interface IdToken {
    iss: string;
    issuer_code?: string;
    user: string;
    userInfo: {
      given_name?: string;
      family_name?: string;
      name?: string;
      email?: string;
    };
    platformInfo: {
      product_family_code?: string;
      version?: string;
      guid?: string;
      name?: string;
      description?: string;
    };
    clientId: string;
    platformId: string;
    deploymentId: string;
    platformContext: {
      contextId: string;
      path: string;
      user: string;
      roles: string[];
      targetLinkUri: string;
      context?: {
        id: string;
        label?: string;
        title?: string;
        type?: string[];
      };
      resource?: { id: string; title?: string; description?: string };
      custom?: Record<string, unknown>;
      launchPresentation?: Record<string, unknown>;
      messageType?: string;
    };
  }

  export interface SetupOptions {
    appRoute?: string;
    loginRoute?: string;
    sessionTimeoutRoute?: string;
    invalidTokenRoute?: string;
    keysetRoute?: string;
    dynRegRoute?: string;
    cookies?: { secure?: boolean; sameSite?: '' | 'None' | 'Lax' | 'Strict' };
    devMode?: boolean;
    tokenMaxAge?: number;
    https?: boolean;
    ssl?: { key: Buffer; cert: Buffer };
    staticPath?: string;
    cors?: boolean;
    serverAddon?: (server: Express) => void;
    dynReg?: {
      url: string;
      name: string;
      logo?: string;
      description?: string;
      redirectUris?: string[];
      customParameters?: Record<string, string>;
      autoActivate?: boolean;
    };
  }

  export interface PlatformConfig {
    url: string;
    name: string;
    clientId: string;
    authenticationEndpoint: string;
    accesstokenEndpoint: string;
    authConfig: { method: 'JWK_SET' | 'JWK_KEY' | 'RSA_KEY'; key: string };
    authorizationServer?: string;
  }

  type LaunchHandler = (
    token: IdToken,
    req: Request,
    res: Response,
    next?: NextFunction
  ) => unknown;

  type ErrorHandler = (req: Request, res: Response, next?: NextFunction) => unknown;

  export interface ProviderInstance {
    setup(key: string, dbConfig: { url?: string; plugin?: unknown; connection?: object }, options?: SetupOptions): void;
    deploy(options: { port?: number; serverless?: boolean }): Promise<void>;
    onConnect(handler: LaunchHandler): void;
    onDeepLinking(handler: LaunchHandler): void;
    onInvalidToken(handler: ErrorHandler): void;
    onSessionTimeout(handler: ErrorHandler): void;
    onUnregisteredPlatform(handler: ErrorHandler): void;
    registerPlatform(cfg: PlatformConfig): Promise<unknown>;
    getPlatform(url: string, clientId: string): Promise<unknown>;
    deletePlatform(url: string, clientId: string): Promise<boolean>;
    appRoute(): string;
    loginRoute(): string;
    keysetRoute(): string;
    dynRegRoute(): string;
    app: Express;
  }

  const ltijs: { Provider: ProviderInstance };
  export default ltijs;
  export const Provider: ProviderInstance;
}

declare module 'ltijs-sequelize' {
  import type { Options } from 'sequelize';
  export default class Database {
    constructor(database: string, user: string, password: string, options: Options);
  }
}
