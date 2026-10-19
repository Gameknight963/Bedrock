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
    action?(event: MenuActionEvent): void;
    disabled?: boolean;
    color?: 'danger' | 'default';
    subtext?: string;
    icon?: unknown;
    leadingAccessory?: { type: 'icon'; icon: unknown } | { type: 'image'; src: string };
    trailingIndicator?: { type: 'icon'; icon: unknown };
    children?: MenuChild[];
}
export interface ContextMenus {
    patch<Props = Record<string, unknown>>(navId: string, callback: (children: MenuChild[], props: Props) => void): Disposer;
    item(props: MenuItem): MenuElement;
}
export interface MessageDraft { content: string; [key: string]: unknown }
export interface ChannelInfo { readonly id: string; readonly [key: string]: unknown }
export interface MessageInfo { readonly id: string; readonly content?: string; readonly channel_id?: string; readonly [key: string]: unknown }
export interface MessageAccessoryProps {
    readonly message: MessageInfo;
    readonly channel?: ChannelInfo;
    readonly signal: AbortSignal;
    readonly [key: string]: unknown;
}
export interface ComponentOptions { order?: number }
export interface ChatBarProps {
    readonly channel: ChannelInfo;
    readonly disabled?: boolean;
    readonly isEmpty?: boolean;
    readonly type?: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    readonly [key: string]: unknown;
}
export interface ChatBar {
    addButton(id: string, component: (props: ChatBarProps) => MenuChild | undefined, options?: ComponentOptions): Disposer;
    button(options: { label: string; icon: MenuChild; disabled?: boolean; pressed?: boolean; onClick(event: MenuActionEvent): void | Promise<void> }): MenuElement;
}
export interface CommandOption {
    name: string;
    description: string;
    type: 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'channel' | 'role' | 'mentionable' | 'attachment';
    required?: boolean;
    choices?: ReadonlyArray<{ name: string; value: string | number }>;
}
export interface CommandContext {
    readonly channelId?: string;
    readonly channel?: ChannelInfo;
    readonly signal: AbortSignal;
    readonly [key: string]: unknown;
}
export interface LocalCommand {
    name: string;
    description: string;
    options?: ReadonlyArray<CommandOption>;
    execute(values: Readonly<Record<string, unknown>>, context: CommandContext): void | Promise<void>;
}
export interface Commands { register(command: LocalCommand): Disposer }
export interface NotificationOptions {
    title: string;
    body?: string;
    type?: 'info' | 'success' | 'error';
    timeout?: number;
    onClick?(): void | Promise<void>;
    actions?: ReadonlyArray<{ label: string; onClick(): void | Promise<void> }>;
}
export interface Notifications { show(options: NotificationOptions): { close: Disposer } }
export interface ReactRuntime {
    readonly Fragment: unknown;
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: (MenuChild | undefined)[]): MenuElement;
    cloneElement(element: MenuElement, props?: Record<string, unknown>): MenuElement;
    isValidElement(value: unknown): value is MenuElement;
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
    useEffect(effect: () => void | Disposer, dependencies?: readonly unknown[]): void;
    useLayoutEffect(effect: () => void | Disposer, dependencies?: readonly unknown[]): void;
    useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
    useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: readonly unknown[]): T;
    useRef<T>(initial: T): { current: T };
    useSyncExternalStore<T>(subscribe: (callback: () => void) => Disposer, getSnapshot: () => T): T;
}
export interface BeforeMessageEvent {
    readonly channelId: string;
    readonly message: MessageDraft;
    readonly signal: AbortSignal;
    cancel(): void;
}
export interface SendOptions { stickerIds?: string[] }
export interface BeforeSendEvent extends BeforeMessageEvent { readonly options: SendOptions }
export interface BeforeEditEvent extends BeforeMessageEvent { readonly messageId: string }
export interface MessageButton {
    label: string;
    icon: unknown;
    disabled?: boolean;
    onClick(event: MenuActionEvent): void | Promise<void>;
    onContextMenu?(event: MenuActionEvent): void | Promise<void>;
}
export interface MessageButtonProps extends MessageAccessoryProps {}
export interface Messages {
    beforeSend(callback: (event: BeforeSendEvent) => void | Promise<void>): Disposer;
    beforeEdit(callback: (event: BeforeEditEvent) => void | Promise<void>): Disposer;
    addAccessory(id: string, component: (props: MessageAccessoryProps) => MenuChild | undefined, options?: ComponentOptions): Disposer;
    addButton(id: string, factory: (props: MessageButtonProps) => MessageButton | null, options?: ComponentOptions): Disposer;
    send(channelId: string, message: MessageDraft): Promise<unknown>;
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
    readonly react: ReactRuntime;
    readonly chatBar: ChatBar;
    readonly commands: Commands;
    readonly notifications: Notifications;
    readonly log: { info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };
    readonly settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; all(): Record<string, unknown> };
    readonly styles: { add(css: string): Disposer };
    readonly webpack: {
        find<T = unknown>(predicate: (value: any) => boolean): T | undefined;
        waitFor<T = unknown>(predicate: (value: any) => boolean): Promise<T>;
        loadChunks(options: { find: string | string[]; match?: RegExp }): Promise<void>;
    };
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
