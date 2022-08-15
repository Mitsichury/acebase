import { BinaryReader, ReadFunction } from './binary-reader';
import { BinaryBPlusTreeLeaf } from './binary-tree-leaf';
import { BinaryBPlusTreeLeafEntry } from './binary-tree-leaf-entry';
import { BinaryBPlusTreeLeafEntryValue } from './binary-tree-leaf-entry-value';
import { BinaryBPlusTreeNode } from './binary-tree-node';
import { BinaryBPlusTreeNodeInfo } from './binary-tree-node-info';
import { BinaryBPlusTreeTransactionOperation } from './binary-tree-transaction-operation';
import { BinaryWriter } from './binary-writer';
import { NodeEntryKeyType } from './entry-key-type';
import { LeafEntryMetaData } from './leaf-entry-metadata';
import { LeafEntryRecordPointer } from './leaf-entry-recordpointer';
import { BPlusTree } from './tree';
import { BPlusTreeBuilder } from './tree-builder';
declare type WriteFunction = (data: number[] | Uint8Array, index: number) => any | Promise<any>;
export declare class BlacklistingSearchOperator {
    check: (entry: BinaryBPlusTreeLeafEntry) => BinaryBPlusTreeLeafEntryValue[];
    /**
     * @param callback callback that runs for each entry, must return an array of the entry values to be blacklisted
     */
    constructor(callback: BlacklistingSearchOperator['check']);
}
export declare class BinaryBPlusTree {
    id?: string;
    static EntryValue: typeof BinaryBPlusTreeLeafEntryValue;
    static TransactionOperation: typeof BinaryBPlusTreeTransactionOperation;
    private _chunkSize;
    private _autoGrow;
    private debugData;
    private _writeFn;
    private _readFn;
    private _originalByteLength?;
    private _fst;
    info: {
        headerLength: number;
        byteLength: number;
        isUnique: boolean;
        hasMetadata: boolean;
        hasFreeSpace: boolean;
        hasFillFactor: boolean;
        hasSmallLeafs: boolean;
        hasLargePtrs: boolean;
        freeSpace: number;
        readonly freeSpaceIndex: number;
        entriesPerNode: number;
        fillFactor: number;
        metadataKeys: string[];
    };
    /**
     * Provides functionality to read and search in a B+tree from a binary data source
     * @param readFn byte array, or function that reads from your data source, must return a promise that resolves with a byte array (the bytes read from file/memory)
     * @param chunkSize numbers of bytes per chunk to read at once
     * @param writeFn function that writes to your data source, must return a promise that resolves once write has completed
     * @param id to edit the tree, pass a unique id to enable "thread-safe" locking
     */
    constructor(readFn: number[] | ReadFunction, chunkSize?: number, writeFn?: WriteFunction, id?: string);
    static test(data: number[]): Promise<void>;
    get autoGrow(): boolean;
    set autoGrow(grow: boolean);
    private _loadInfo;
    private _getReader;
    private _readChild;
    private _getLeaf;
    private _writeNode;
    private _writeLeaf;
    /**
     * TODO: rename to `parseNode` or something
     */
    _getNode(nodeInfo: BinaryBPlusTreeNodeInfo, reader: BinaryReader): BinaryBPlusTreeNode;
    /**
     *
     * @param mode If the requested lock is shared (reads) or exclusive (writes)
     * @param fn function to execute with lock in place
     * @returns
     */
    _threadSafe<ReturnType = any>(mode: 'exclusive' | 'shared', fn: () => ReturnType | Promise<ReturnType>): Promise<ReturnType>;
    getFirstLeaf(options?: {
        stats?: boolean;
    }): Promise<BinaryBPlusTreeLeaf>;
    private _getFirstLeaf;
    getLastLeaf(options?: {
        stats?: boolean;
    }): Promise<BinaryBPlusTreeLeaf>;
    private _getLastLeaf;
    findLeaf(searchKey: NodeEntryKeyType, options?: {
        stats?: boolean;
    }): Promise<BinaryBPlusTreeLeaf>;
    private _findLeaf;
    /**
     * Searches the tree
     * @param op operator to use for key comparison, can be single value operators "<", "<=", "==", "!=", ">", ">=", "matches", "!matches", double value operators "between", "!between", and multiple value operators "in", "!in"
     * @param param single value or array for double/multiple value operators
     * @param include what data to include in results. `filter`: recordPointers to filter upon
     * @returns {Promise<{ entries?: BinaryBPlusTreeLeafEntry[], keys?: Array, keyCount?: number, valueCount?: number, values?: BinaryBPlusTreeLeafEntryValue[] }}
     */
    search(op: string | BlacklistingSearchOperator, param: NodeEntryKeyType | NodeEntryKeyType[], include?: {
        entries?: boolean;
        values?: boolean;
        keys?: boolean;
        count?: boolean;
        filter?: BinaryBPlusTreeLeafEntry[];
    }): Promise<{
        entries: BinaryBPlusTreeLeafEntry[];
        keys: NodeEntryKeyType[];
        keyCount: number;
        valueCount: number;
        values: BinaryBPlusTreeLeafEntryValue[];
    }>;
    /**
     * Searches the tree
     * @param op operator to use for key comparison, can be single value operators "<", "<=", "==", "!=", ">", ">=", "matches", "!matches", double value operators "between", "!between", and multiple value operators "in", "!in"
     * @param param single value or array for double/multiple value operators
     * @param include what data to include in results. `filter`: recordPointers to filter upon
     * @returns {Promise<{ entries?: BinaryBPlusTreeLeafEntry[]; keys?: Array; keyCount?: number; valueCount?: number; values?: BinaryBPlusTreeLeafEntryValue[] }>}
     */
    private _search;
    /**
     * @returns returns a promise that resolves with 1 value (unique keys), a values array or the number of values (options.stats === true)
     */
    find(searchKey: NodeEntryKeyType, options?: {
        stats?: boolean;
    }): Promise<number | BinaryBPlusTreeLeafEntryValue | BinaryBPlusTreeLeafEntryValue[]>;
    /**
     * @returns returns a promise that resolves with 1 value (unique keys), a values array or the number of values (options.stats === true)
     */
    _find(searchKey: NodeEntryKeyType, options?: {
        stats?: boolean;
    }): Promise<number | BinaryBPlusTreeLeafEntryValue | BinaryBPlusTreeLeafEntryValue[]>;
    /**
     * @param options `existingOnly`: Whether to only return lookup results for keys that were actually found
     */
    findAll(keys: NodeEntryKeyType[], options?: {
        existingOnly: boolean;
    }): Promise<{
        key: NodeEntryKeyType;
        value: any;
    }[]>;
    _findAll(keys: NodeEntryKeyType[], options?: {
        existingOnly: boolean;
    }): Promise<{
        key: NodeEntryKeyType;
        value: any;
    }[]>;
    _growTree(bytesNeeded: number): Promise<void>;
    writeAllocationBytes(): Promise<void>;
    _writeAllocationBytes(): Promise<void>;
    _registerFreeSpace(index: number, length: number): Promise<void>;
    _claimFreeSpace(bytesRequired: number): Promise<void>;
    _requestFreeSpace(bytesRequired: number): Promise<{
        index: number;
        length: number;
    }>;
    /**
     *
     * @param {BinaryBPlusTreeLeaf} leaf
     * @param {object} options
     * @param {boolean} [options.growData=false]
     * @param {boolean} [options.growExtData=false]
     * @param {(leaf: BinaryBPlusTreeLeaf) => any} [options.applyChanges] callback function to apply changes to leaf before writing
     * @param {boolean} [options.rollbackOnFailure=true] Whether to rewrite the original leaf on failure (only done if this is a one leaf tree) - disable if this rebuild is called because of a failure to write an updated leaf (rollback will fail too!)
     */
    _rebuildLeaf(leaf: BinaryBPlusTreeLeaf, options?: {
        growData?: boolean;
        growExtData?: boolean;
        rollbackOnFailure?: boolean;
        applyChanges?: (leaf: BinaryBPlusTreeLeaf) => any;
        prevLeaf?: BinaryBPlusTreeLeaf;
        nextLeaf?: BinaryBPlusTreeLeaf;
    }): Promise<any>;
    _splitNode(node: BinaryBPlusTreeNode, options?: {
        keepEntries?: number;
        cancelCallback?: () => unknown;
    }): Promise<{
        node1: BinaryBPlusTreeNode;
        node2: BinaryBPlusTreeNode;
    }>;
    _splitLeaf(leaf: BinaryBPlusTreeLeaf, options?: {
        nextLeaf?: BinaryBPlusTreeLeaf;
        keepEntries?: number;
        cancelCallback?: () => unknown;
    }): Promise<any>;
    add(key: NodeEntryKeyType, recordPointer: LeafEntryRecordPointer, metadata: LeafEntryMetaData): Promise<any>;
    _add(key: NodeEntryKeyType, recordPointer: LeafEntryRecordPointer, metadata: LeafEntryMetaData): Promise<any>;
    _process(operations: BinaryBPlusTreeTransactionOperation[]): Promise<void>;
    remove(key: NodeEntryKeyType, recordPointer?: LeafEntryRecordPointer): Promise<void | unknown[]>;
    _remove(key: NodeEntryKeyType, recordPointer?: LeafEntryRecordPointer): Promise<void | unknown[]>;
    /**
     * Removes an empty leaf
     */
    _removeLeaf(leaf: BinaryBPlusTreeLeaf): Promise<void>;
    update(key: NodeEntryKeyType, newRecordPointer: LeafEntryRecordPointer, currentRecordPointer?: LeafEntryRecordPointer, newMetadata?: LeafEntryMetaData): Promise<unknown[]>;
    _update(key: NodeEntryKeyType, newRecordPointer: LeafEntryRecordPointer, currentRecordPointer?: LeafEntryRecordPointer, newMetadata?: LeafEntryMetaData): Promise<unknown[]>;
    /**
     * Executes all operations until execution fails: remaining operations are left in passed array
     */
    transaction(operations: BinaryBPlusTreeTransactionOperation[]): Promise<void>;
    _transaction(operations: BinaryBPlusTreeTransactionOperation[]): Promise<void>;
    toTree(fillFactor?: number): Promise<BPlusTree>;
    /**
     * @returns Promise that resolves with a BPlusTreeBuilder
     */
    toTreeBuilder(fillFactor: number): Promise<BPlusTreeBuilder>;
    /**
     * @returns Promise that resolves with a BPlusTreeBuilder
     */
    _toTreeBuilder(fillFactor: number): Promise<BPlusTreeBuilder>;
    rebuild(writer: BinaryWriter, options?: {
        /** bytes that have been pre-allocated, enforces a max writable byte length */
        allocatedBytes?: number;
        /** number between 0-100 indicating the percentage of node and leaf filling, leaves room for later adds to the tree. Default is `95` */
        fillFactor?: number;
        /** whether free space for later node/leaf creation is kept or added. If `allocatedBytes` is not given (or 0), 10% free space will be used. Default is `true` */
        keepFreeSpace?: boolean;
        /** whether to increase the max amount of node/leaf entries (usually rebuilding is needed because of growth, so this might be a good idea). Default is true, will increase max entries with 10% (until the max of 255 is reached) */
        increaseMaxEntries?: boolean;
        /** optionally reserves free space for specified amount of new leaf entries (overrides the default of 10% growth, only applies if `allocatedBytes` is not specified or 0). Default is `0` */
        reserveSpaceForNewEntries?: number;
        /** object that will be updated with statistics as the tree is written */
        treeStatistics?: Partial<{
            byteLength: number;
            totalEntries: number;
            totalValues: number;
            totalLeafs: number;
            depth: number;
            entriesPerNode: number;
        }>;
    }): Promise<void>;
    _rebuild(writer: BinaryWriter, options?: {
        /** bytes that have been pre-allocated, enforces a max writable byte length */
        allocatedBytes?: number;
        /** number between 0-100 indicating the percentage of node and leaf filling, leaves room for later adds to the tree. Default is `95` */
        fillFactor?: number;
        /** whether free space for later node/leaf creation is kept or added. If `allocatedBytes` is not given (or 0), 10% free space will be used. Default is `true` */
        keepFreeSpace?: boolean;
        /** whether to increase the max amount of node/leaf entries (usually rebuilding is needed because of growth, so this might be a good idea). Default is true, will increase max entries with 10% (until the max of 255 is reached) */
        increaseMaxEntries?: boolean;
        /** optionally reserves free space for specified amount of new leaf entries (overrides the default of 10% growth, only applies if `allocatedBytes` is not specified or 0). Default is `0` */
        reserveSpaceForNewEntries?: number;
        /** object that will be updated with statistics as the tree is written */
        treeStatistics?: Partial<{
            byteLength: number;
            totalEntries: number;
            totalValues: number;
            totalLeafs: number;
            depth: number;
            entriesPerNode: number;
        }>;
    }): Promise<void>;
    static create(options: {
        getLeafStartKeys: (entriesPerLeaf: number) => Promise<NodeEntryKeyType[]>;
        getEntries: (n: number) => Promise<BinaryBPlusTreeLeafEntry[]>;
        writer: BinaryWriter;
        treeStatistics: Partial<{
            totalLeafs: number;
            depth: number;
            writtenLeafs: number;
            writtenEntries: number;
            byteLength: number;
            freeBytes: number;
        }>;
        /** @default 100 */
        fillFactor?: number;
        /** @default 255 */
        maxEntriesPerNode?: number;
        isUnique: boolean;
        metadataKeys?: string[];
        allocatedBytes: number;
        /** @default true */
        keepFreeSpace?: boolean;
        /** @default 0 */
        reserveSpaceForNewEntries?: number;
    }): Promise<void>;
    /**
     * Creates a binary tree from a stream of entries.
     * An entry stream must be a binary data stream containing only leaf entries
     * a leaf entry can be created using BinaryBPlusTree.createStreamEntry(key, values)
     */
    static createFromEntryStream(reader: BinaryReader, writer: BinaryWriter, options: {
        treeStatistics: Partial<{
            totalLeafs: number;
            depth: number;
            writtenLeafs: number;
            writtenEntries: number;
            byteLength: number;
            freeBytes: number;
            totalEntries: number;
        }>;
        /** @default 100 */
        fillFactor?: number;
        /** @default 255 */
        maxEntriesPerNode?: number;
        isUnique: boolean;
        metadataKeys?: string[];
        allocatedBytes?: number;
        /** @default true */
        keepFreeSpace?: boolean;
    }): Promise<void>;
}
export {};