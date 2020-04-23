/// <reference types="acebase-core" />

// import { EventEmitter } from 'events';
import * as acebasecore from 'acebase-core';

export class AceBase extends acebasecore.AceBaseBase {
    /**
     * 
     * @param {string} dbname | Name of the database to open or create
     * @param {AceBaseLocalSettings} options | 
     */
    constructor(dbname: string, options?: AceBaseLocalSettings);

    /**
     * Waits for the database to be ready before running your callback. Do this before performing any other actions on your database
     * @param {()=>void} [callback] (optional) callback function that is called when ready. You can also use the returned promise
     * @returns {Promise<void>} returns a promise that resolves when ready
     */
    ready(callback?: () => void): Promise<void>;

    /** 
     * Only available in browser context - Creates an AceBase database instance using IndexedDB as storage engine. Creates a dedicated IndexedDB instance.
     * @param dbname Name of the database
     * @param settings optional settings
     * @param settings.logLevel what level to use for logging to the console
     */
    static WithIndexedDB(name: string, settings?: { logLevel?: 'verbose'|'log'|'warn'|'error' }): AceBase;

    /**
     * Only available in browser context - Creates an AceBase database instance using LocalStorage or SessionStorage as storage engine
     * @param dbname Name of the database
     * @param settings optional settings
     * @param settings.logLevel what level to use for logging to the console
     * @param settings.temp whether to use sessionStorage instead of localStorage
     * @param settings.provider Alternate localStorage provider. Eg using 'node-localstorage'
     */    
    static WithLocalStorage(dbname: string, settings: { logLevel?: 'verbose'|'log'|'warn'|'error', temp?: boolean, provider?: any }): AceBase
}

export interface AceBaseLocalSettings {
    logLevel?: 'verbose'|'log'|'warn'|'error';
    storage?: StorageSettings;
}

export abstract class StorageSettings {
    maxInlineValueSize?: number;
    removeVoidProperties?: boolean;
    path?: string;
}

export class AceBaseStorageSettings extends StorageSettings {
    constructor(settings: AceBaseStorageSettings);
    recordSize?: number;
    pageSize?: number;
}

export class SQLiteStorageSettings extends StorageSettings {
    constructor(settings: SQLiteStorageSettings);
}

export class MSSQLStorageSettings extends StorageSettings {
    constructor(settings: MSSQLStorageSettings);
    driver?: 'tedious'|'native';
    domain?: string;
    user?: string;
    password?: string;
    server?: string;
    port?: number;
    database?: string;
    encrypt?: boolean;
    appName?: string;
    connectionTimeout?: number;
    requestTimeout?: number;
    maxConnections?: number;
    minConnections?: number;
    idleTimeout?: number;
}

export class LocalStorageSettings extends StorageSettings {
    constructor(settings: LocalStorageSettings);
    session?: boolean;
    provider?: object;
}

export interface ICustomStorageNodeMetaData {
    /** cuid (time sortable revision id). Nodes stored in the same operation share this id */
    revision: string; 
    /** Number of revisions, starting with 1. Resets to 1 after deletion and recreation */
    revision_nr: number;
    /** Creation date/time in ms since epoch UTC */
    created: number;
    /** Last modification date/time in ms since epoch UTC */
    modified: number;
    /** Type of the node's value. 1=object, 2=array, 3=number, 4=boolean, 5=string, 6=date, 7=reserved, 8=binary, 9=reference */
    type: number;
}
export interface ICustomStorageNodeValue {
    /** only Object, Array or string values */
    value: any
}
export interface ICustomStorageNode extends ICustomStorageNodeMetaData, ICustomStorageNodeValue {}

/**
 * Allows data to be stored in a custom storage backend of your choice! Simply provide a couple of functions
 * to get, set and remove data and you're done.
 */
export class CustomStorageSettings extends StorageSettings {
    constructor(settings: CustomStorageSettings);
    /** Name of the custom storage adapter */
    name?: string;
    /** Function that returns a Promise that resolves once your data store backend is ready for use */
    ready(): Promise<any>;
    /** Function that gets the node with given path from your custom data store, must return null if it doesn't exist */
    get(path: string): Promise<ICustomStorageNode|null>;
    /** Function that inserts or updates a node with given path in your custom data store */
    set(path: string, value: ICustomStorageNode): Promise<void>;
    /** Function that removes the node with given path from your custom data store */
    remove(path: string): Promise<void>;
    /** Function that streams all stored nodes that are direct children of the given path. For path "parent/path", results must include paths such as "parent/path/key" AND "parent/path[0]". 👉🏻 You can use CustomStorageHelpers for logic. Keep calling the add callback for each node until it returns false. */
    childrenOf(path: string, include: { value: boolean, metadata: boolean }, checkCallback: (childPath: string) => boolean, addCallback: (childPath: string, node?: ICustomStorageNodeMetaData|ICustomStorageNode) => boolean): Promise<any>;
    /** Function that streams all stored nodes that are descendants of the given path. For path "parent/path", results must include paths such as "parent/path/key", "parent/path/key/subkey", "parent/path[0]", "parent/path[12]/key" etc. 👉🏻 You can use CustomStorageHelpers for logic. Keep calling the add callback for each node until it returns false. */
    descendantsOf(path: string, include: { value: boolean, metadata: boolean }, checkCallback: (childPath: string) => boolean, addCallback: (descPath: string, node?: ICustomStorageNodeMetaData|ICustomStorageNode) => boolean): Promise<any>;
    // /** (optional, not used yet) Function that gets multiple nodes (metadata AND value) from your custom data store at once. Must return a Promise that resolves with Map<path,value> */
    // getMultiple?(paths: string[]): Promise<Map<string, ICustomStorageNode|null>>;
    /** (optional) Function that removes multiple nodes from your custom data store at once */
    removeMultiple?(paths: string[]): Promise<void>;
}

export class CustomStorageHelpers {
    /**
     * Helper function that returns a SQL where clause for all children of given path
     * @param path Path to get children of
     * @param columnName Name of the Path column in your SQL db, default is 'path'
     * @returns Returns the SQL where clause
     */
    static ChildPathsSql(path:string, columnName?:string): string;
    /**
     * Helper function that returns a regular expression to test if paths are children of the given path
     * @param path Path to test children of
     * @returns Returns regular expression to test paths with
     */
    static ChildPathsRegex(path: string): RegExp;
    /**
     * Helper function that returns a SQL where clause for all descendants of given path
     * @param path Path to get descendants of
     * @param columnName Name of the Path column in your SQL db, default is 'path'
     * @returns Returns the SQL where clause
     */
    static DescendantPathsSql(path:string, columnName?:string): string;
    /**
     * Helper function that returns a regular expression to test if paths are descendants of the given path
     * @param path Path to test descendants of
     * @returns Returns regular expression to test paths with
     */
    static DescendantPathsRegex(path: string): RegExp;

    /**
     * PathInfo helper class. Can be used to extract keys from a given path, get parent paths, check if a path is a child or descendant of other path etc
     * @example
     * var pathInfo = CustomStorage.PathInfo.get('my/path/to/data');
     * pathInfo.key === 'data';
     * pathInfo.parentPath === 'my/path/to';
     * pathInfo.pathKeys; // ['my','path','to','data'];
     * pathInfo.isChildOf('my/path/to') === true;
     * pathInfo.isDescendantOf('my/path') === true;
     * pathInfo.isParentOf('my/path/to/data/child') === true;
     * pathInfo.isAncestorOf('my/path/to/data/child/grandchild') === true;
     * pathInfo.childPath('child') === 'my/path/to/data/child';
     * pathInfo.childPath(0) === 'my/path/to/data[0]';
     */
    static readonly PathInfo: typeof acebasecore.PathInfo
}

// export class BrowserAceBase extends AceBase {
//     /**
//      * DEPRECATED - switch to static WithIndexedDB or WithLocalStorage methods.
//      * Convenience class for using AceBase in the browser without supplying additional settings.
//      * Uses the browser's localStorage or sessionStorage.
//      * @deprecated Using the AceBase constructor method in the browser is deprecated, use the static WithIndexedDB or WithLocalStorage methods instead
//      * @param name database name
//      * @param settings optional settings
//      * @param settings.logLevel what level to use for logging to the console
//      * @param settings.temp whether to use sessionStorage instead of localStorage
//      */
//     constructor(name: string, settings?: { logLevel?: 'verbose'|'log'|'warn'|'error', temp?: boolean });

//     /* static methods WithIndexedDB and WithLocalStorage are defined in class AceBase */
// }

export import DataSnapshot = acebasecore.DataSnapshot;
export import DataReference = acebasecore.DataReference;
export import EventStream = acebasecore.EventStream;
export import EventSubscription = acebasecore.EventSubscription;
export import PathReference = acebasecore.PathReference;
export import TypeMappings = acebasecore.TypeMappings;
export import TypeMappingOptions = acebasecore.TypeMappingOptions;