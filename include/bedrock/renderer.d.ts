export type Disposer = () => void;
export interface MenuElement { readonly type: unknown; readonly props: Readonly<Record<string, unknown>>; readonly key?: string | null }
export type MenuChild = MenuElement | string | number | null | false | MenuChild[];
export interface MenuActionEvent {
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    preventDefault(): void;
    stopPropagation(): void;
}
export interface MenuItem {
    id: string;
    label: string;
    action(event: MenuActionEvent): void;
    disabled?: boolean;
    color?: 'danger' | 'default';
    subtext?: string;
    icon?: unknown;
    children?: MenuChild[];
}
export interface ContextMenus {
    patch<Props = Record<string, unknown>>(navId: string, callback: (children: MenuChild[], props: Props) => void): Disposer;
    item(props: MenuItem): MenuElement;
}
export interface MessageDraft { content: string }
export interface BeforeSendEvent {
    readonly channelId: string;
    readonly message: MessageDraft;
    readonly signal: AbortSignal;
    cancel(): void;
}
export interface BeforeEditEvent extends BeforeSendEvent { readonly messageId: string }
export interface Messages {
    beforeSend(callback: (event: BeforeSendEvent) => void | Promise<void>): Disposer;
    beforeEdit(callback: (event: BeforeEditEvent) => void | Promise<void>): Disposer;
}
export interface SourceReplacement {
    match: string | RegExp;
    replace: string | ((match: string, ...captures: any[]) => string);
}
export interface SourcePatch {
    id?: string;
    find: string;
    all?: boolean;
    replacement: SourceReplacement | SourceReplacement[];
}
export interface SourcePatchStatus {
    id: string;
    find: string;
    state: 'waiting' | 'applied' | 'failed' | 'restart-required';
    modules: string[];
    error: string | null;
}
export interface RendererContext {
    readonly id: string;
    readonly signal: AbortSignal;
    readonly manifest: Readonly<Record<string, unknown>>;
    readonly contextMenus: ContextMenus;
    readonly messages: Messages;
    readonly log: { info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
    readonly settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; all(): Record<string, unknown> };
    readonly styles: { add(css: string): Disposer };
    readonly webpack: { find<T = unknown>(predicate: (value: any) => boolean): T | undefined; waitFor<T = unknown>(predicate: (value: any) => boolean): Promise<T> };
    readonly patches: {
        before(object: object, method: string, callback: (args: any[], receiver: any) => void): Disposer;
        after(object: object, method: string, callback: (args: any[], result: any, receiver: any) => any): Disposer;
        instead(object: object, method: string, callback: (args: any[], next: (...args: any[]) => any, receiver: any) => any): Disposer;
    };
    readonly events: { on(name: string, callback: (event: { id: string; value: any }) => void | Promise<void>): Disposer; emit(name: string, value: unknown): Promise<void> };
    cleanup(callback: Disposer): Disposer;
    reportStatus(message: string): void;
    requireRestart(reason: string): void;
}

export interface SettingDefinition {
    type: 'boolean' | 'string' | 'number' | 'select' | 'slider';
    default: unknown;
    label?: string;
    description?: string;
    restartNeeded?: boolean;
    options?: ReadonlyArray<{ label: string; value: unknown }>;
    min?: number;
    max?: number;
    step?: number;
}
export interface PluginSettings<Definitions extends Record<string, SettingDefinition>> {
    readonly definitions: Definitions;
    readonly store: { [Key in keyof Definitions]: Definitions[Key]['default'] };
    set<Key extends keyof Definitions>(key: Key, value: Definitions[Key]['default']): Promise<void>;
    reset(key: keyof Definitions): Promise<void>;
    subscribe(callback: (key: keyof Definitions, value: Definitions[keyof Definitions]['default']) => void): Disposer;
    flush(): Promise<void>;
    use<Key extends keyof Definitions>(keys: Key[]): Pick<PluginSettings<Definitions>['store'], Key>;
}
declare global {
    const Bedrock: {
        definePluginSettings<Definitions extends Record<string, SettingDefinition>>(definitions: Definitions): PluginSettings<Definitions>;
        readonly OptionType: { readonly BOOLEAN: 'boolean'; readonly STRING: 'string'; readonly NUMBER: 'number'; readonly SELECT: 'select'; readonly SLIDER: 'slider' };
    };
}
