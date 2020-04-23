const { debug, ID, PathReference, PathInfo, ascii85 } = require('acebase-core');
const { NodeInfo } = require('./node-info');
const { VALUE_TYPES } = require('./node-value-types');
const { Storage, StorageSettings, NodeNotFoundError } = require('./storage');


/** Interface for metadata being stored for nodes */
class ICustomStorageNodeMetaData {
    constructor() {
        /** cuid (time sortable revision id). Nodes stored in the same operation share this id */
        this.revision = '';
        /** Number of revisions, starting with 1. Resets to 1 after deletion and recreation */
        this.revision_nr = 0;
        /** Creation date/time in ms since epoch UTC */
        this.created = 0;
        /** Last modification date/time in ms since epoch UTC */
        this.modified = 0;
        /** Type of the node's value. 1=object, 2=array, 3=number, 4=boolean, 5=string, 6=date, 7=reserved, 8=binary, 9=reference */
        this.type = 0;
    }
}

/** Interface for metadata combined with a stored value */
class ICustomStorageNode extends ICustomStorageNodeMetaData {
    constructor() {
        super();
        /** @type {any} only Object, Array or string values. */
        this.value = null;
    }
}

/** Enables get/set/remove operations to be wrapped in transactions to improve performance and reliability. */
class CustomStorageTransaction {
    /**
     * @param {string} path 
     * @returns {Promise<ICustomStorageNode>}
     */
    get(path) { throw new Error(`CustomStorageTransaction.get must be overridden by subclass`); }
    /**
     * @param {string} path 
     * @param {ICustomStorageNode} node
     * @returns {Promise<any>}
     */
    set(path, node) { throw new Error(`CustomStorageTransaction.set must be overridden by subclass`); }
    /**
     * @param {string} path
     * @returns {Promise<any>}
     */
    remove(path) { throw new Error(`CustomStorageTransaction.remove must be overridden by subclass`); }
    /**
     * @param {string} reason 
     * @returns {Promise<any>}
     */
    rollback(reason) { throw new Error(`CustomStorageTransaction.rollback must be overridden by subclass`); }
    /**
     * @returns {Promise<any>}
     */
    commit() { throw new Error(`CustomStorageTransaction.rollback must be overridden by subclass`); }
    constructor() {
        /** @type {string} Transaction ID */
        this.id = ID.generate();
    }
}

/**
 * Allows data to be stored in a custom storage backend of your choice! Simply provide a couple of functions
 * to get, set and remove data and you're done.
 */
class CustomStorageSettings extends StorageSettings {
    /**
     * 
     * @param {object} settings 
     * @param {string} settings.name Name of the custom storage adapter
     * @param {() => Promise<any>} settings.ready Function that returns a Promise that resolves once your data store backend is ready for use
     * @param {(path: string) => Promise<ICustomStorageNode|null>} settings.get Function that gets the node with given path from your custom data store, must return null if it doesn't exist
     * @param {(path: string, value: ICustomStorageNode) => Promise<void>} settings.set Function that inserts or updates a node with given path in your custom data store
     * @param {(path: string) => Promise<void>} settings.remove Function that removes the node with given path from your custom data store
     * @param {(path: string, include: { value: boolean, metadata: boolean }, checkCallback: (childPath: string) => boolean, addCallback: (childPath: string, node?: ICustomStorageNodeMetaData|ICustomStorageNode) => boolean) => Promise<any>} settings.childrenOf Function that streams all stored nodes that are direct children of the given path. For path "parent/path", results must include paths such as "parent/path/key" AND "parent/path[0]". 👉🏻 You can use CustomStorageHelpers for logic. Keep calling the add callback for each node until it returns false.
     * @param {(path: string, include: { value: boolean, metadata: boolean }, checkCallback: (childPath: string) => boolean, addCallback: (descPath: string, node?: ICustomStorageNodeMetaData|ICustomStorageNode) => boolean) => Promise<any>} settings.descendantsOf Function that streams all stored nodes that are descendants of the given path. For path "parent/path", results must include paths such as "parent/path/key", "parent/path/key/subkey", "parent/path[0]", "parent/path[12]/key" etc. 👉🏻 You can use CustomStorageHelpers for logic. Keep calling the add callback for each node until it returns false.
     * @param {(paths: string[]) => Promise<Map<string, ICustomStorageNode|null>>} [settings.getMultiple] (optional, not used yet) Function that gets multiple nodes (metadata AND value) from your custom data store at once. Must return a Promise that resolves with Map<path,node>
     * @param {(paths: string[]) => Promise<void>} [settings.removeMultiple] (optional) Function that removes multiple nodes from your custom data store at once
     */
     constructor(settings) {
        super(settings);
        settings = settings || {};
        if (typeof settings.ready !== 'function') {
            throw new Error(`ready must be a function`);
        }
        if (typeof settings.get !== 'function') {
            throw new Error(`get must be a function`);
        }
        if (typeof settings.set !== 'function') {
            throw new Error(`set must be a function`);
        }
        if (typeof settings.remove !== 'function') {
            throw new Error(`remove must be a function`);
        }
        if (typeof settings.childrenOf !== 'function') {
            throw new Error(`childrenOf must be a function`);
        }
        if (typeof settings.descendantsOf !== 'function') {
            throw new Error(`descendantsOf must be a function`);
        }
        this.name = settings.name;
        this.info = `${this.name || 'CustomStorage'} realtime database`;
        this.ready = settings.ready;
        this.get = settings.get;
        this.getMultiple = settings.getMultiple 
            || (paths => {
                const map = new Map();
                return Promise.all(paths.map(path => this.get(path).then(val => map.set(path, val))))
                .then(done => map);
            });
        this.set = settings.set;
        this.remove = settings.remove;
        this.removeMultiple = settings.removeMultiple 
            || (paths => {
                return Promise.all(paths.map(path => this.remove(path)))
                .then(done => true);
            });
        this.childrenOf = settings.childrenOf;
        this.descendantsOf = settings.descendantsOf;
    }
};

class CustomStorageNodeAddress {
    constructor(containerPath) {
        this.path = containerPath;
    }
}

class CustomStorageNodeInfo extends NodeInfo {
    constructor(info) {
        super(info);

        /** @type {CustomStorageNodeAddress} */
        this.address; // no assignment, only typedef

        /** @type {string} */
        this.revision = info.revision;
        /** @type {number} */
        this.revision_nr = info.revision_nr;
        /** @type {Date} */
        this.created = info.created;
        /** @type {Date} */
        this.modified = info.modified;
    }
}

/**
 * Helper functions to build custom storage classes with
 */
class CustomStorageHelpers {
    /**
     * Helper function that returns a SQL where clause for all children of given path
     * @param {string} path Path to get children of
     * @param {string} [columnName] Name of the Path column in your SQL db, default is 'path'
     * @returns {string} Returns the SQL where clause
     */
    static ChildPathsSql(path, columnName = 'path') {
        const where = path === '' 
            ? `${columnName} <> '' AND ${columnName} NOT LIKE '%/%'` 
            : `(${columnName} LIKE '${path}/%' OR ${columnName} LIKE '${path}[%') AND ${columnName} NOT LIKE '${path}/%/%' AND ${columnName} NOT LIKE '${path}[%]/%' AND ${columnName} NOT LIKE '${path}[%][%'`
        return where;
    }

    /**
     * Helper function that returns a regular expression to test if paths are children of the given path
     * @param {string} path Path to test children of
     * @returns {RegExp} Returns regular expression to test paths with
     */
    static ChildPathsRegex(path) {
        return new RegExp(`^${path}(?:/[^/\[]+|\[[0-9]+\])$`);
    }

    /**
     * Helper function that returns a SQL where clause for all descendants of given path
     * @param {string} path Path to get descendants of
     * @param {string} [columnName] Name of the Path column in your SQL db, default is 'path'
     * @returns {string} Returns the SQL where clause
     */
    static DescendantPathsSql(path, columnName = 'path') {
        const where = path === '' 
            ? `${columnName} <> ''` 
            : `${columnName} LIKE '${path}/%' OR ${columnName} LIKE '${path}[%'`
        return where;
    }
    /**
     * Helper function that returns a regular expression to test if paths are descendants of the given path
     * @param {string} path Path to test descendants of
     * @returns {RegExp} Returns regular expression to test paths with
     */
    static DescendantPathsRegex(path) {
        return new RegExp(`^${path}(?:/[^/\[]+|\[[0-9]+\])`);
    }

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
    static get PathInfo() {
        return PathInfo;
    }
}

class CustomStorage extends Storage {

    /**
     * 
     * @param {string} dbname 
     * @param {CustomStorageSettings} settings 
     */
    constructor(dbname, settings) {
        super(dbname, settings);

        this._init();
    }


    _init() {
        /** @type {CustomStorageSettings} */
        this._customImplementation = this.settings;
        this.debug.log(`Database "${this.name}" details:`.intro);
        this.debug.log(`- Type: CustomStorage`);
        this.debug.log(`- Path: ${this.settings.path}`);
        this.debug.log(`- Max inline value size: ${this.settings.maxInlineValueSize}`.intro);
        this.debug.log(`- Autoremove undefined props: ${this.settings.removeVoidProperties}`);

        // Create root node if it's not there yet
        return this._customImplementation.ready()
        .then(ready => this.getNodeInfo(''))
        .then(info => {
            if (!info.exists) {
                return this._writeNode('', {});
            }
        })
        .then(() => {
            return this.indexes.supported && this.indexes.load();
        })
        .then(() => {
            this.emit('ready');
        });
    }

    /**
     * 
     * @param {string} path 
     * @param {object} info 
     * @param {number} info.type
     * @param {any} info.value
     * @param {string} info.revision
     * @param {number} info.revision_nr
     * @param {number} info.created
     * @param {number} info.modified
     * @returns {Promise<void>}
     */
    _storeNode(path, info) {
        // serialize the value to store
        const getTypedChildValue = val => {
            if (val === null) {
                throw new Error(`Not allowed to store null values. remove the property`);
            }
            else if (['string','number','boolean'].includes(typeof val)) {
                return val;
            }
            else if (val instanceof Date) {
                return { type: VALUE_TYPES.DATETIME, value: val.getTime() };
            }
            else if (val instanceof PathReference) {
                return { type: VALUE_TYPES.REFERENCE, value: child.path };
            }
            else if (val instanceof ArrayBuffer) {
                return { type: VALUE_TYPES.BINARY, value: ascii85.encode(val) };
            }
            else if (typeof val === 'object') {
                console.assert(Object.keys(val).length === 0, 'child object stored in parent can only be empty');
                return val;
            }
        }

        const unprocessed = `Caller should have pre-processed the value by converting it to a string`;
        if (info.type === VALUE_TYPES.ARRAY && info.value instanceof Array) {
            // Convert array to object with numeric properties
            // NOTE: caller should have done this already
            console.warn(`Unprocessed array. ${unprocessed}`);
            const obj = {};
            for (let i = 0; i < info.value.length; i++) {
                obj[i] = info.value[i];
            }
            info.value = obj;
        }
        if (info.type === VALUE_TYPES.BINARY && typeof info.value !== 'string') {
            console.warn(`Unprocessed binary value. ${unprocessed}`);
            info.value = ascii85.encode(info.value);
        }
        if (info.type === VALUE_TYPES.REFERENCE && info.value instanceof PathReference) {
            console.warn(`Unprocessed path reference. ${unprocessed}`);
            info.value = info.value.path;
        }
        if ([VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(info.type)) {
            const original = info.value;
            info.value = {};
            // If original is an array, it'll automatically be converted to an object now
            Object.keys(original).forEach(key => {
                info.value[key] = getTypedChildValue(original[key]);
            });
        }

        return this._customImplementation.set(path, info);
    }

    /**
     * 
     * @param {ICustomStorageNode} node 
     */
    _processReadNodeValue(node) {

        const getTypedChildValue = val => {
            // Typed value stored in parent record
            if (val.type === VALUE_TYPES.BINARY) {
                // binary stored in a parent record as a string
                return ascii85.decode(val.value);
            }
            else if (val.type === VALUE_TYPES.DATETIME) {
                // Date value stored as number
                return new Date(val.value);
            }
            else if (val.type === VALUE_TYPES.REFERENCE) {
                // Path reference stored as string
                return new PathReference(val.value);
            }
            else {
                throw new Error(`Unhandled child value type ${val.type}`);
            }            
        }

        switch (node.type) {

            case VALUE_TYPES.ARRAY:
            case VALUE_TYPES.OBJECT: {
                // check if any value needs to be converted
                // NOTE: Arrays are stored with numeric properties
                const obj = node.value;
                Object.keys(obj).forEach(key => {
                    let item = obj[key];
                    if (typeof item === 'object' && 'type' in item) {
                        obj[key] = getTypedChildValue(item);
                    }
                });
                node.value = obj;
                break;
            }

            case VALUE_TYPES.BINARY: {
                node.value = ascii85.decode(node.value);
                break;
            }

            case VALUE_TYPES.REFERENCE: {
                node.value = new PathReference(node.value);
                break;
            }

            case VALUE_TYPES.STRING: {
                // No action needed 
                // node.value = node.value;
                break;
            }

            default:
                throw new Error(`Invalid standalone record value type`); // should never happen
        }
    }

    async _readNode(path) {
        // deserialize a stored value (always an object with "type", "value", "revision", "revision_nr", "created", "modified")
        let node = await this._customImplementation.get(path);
        if (node === null) { return null; }
        if (typeof node !== 'object') {
            throw new Error(`CustomStorage get function must return an ICustomStorageNode object. Use JSON.parse if your set function stored it as a string`);
        }

        this._processReadNodeValue(node);
        return node;
    }

    _getTypeFromStoredValue(val) {
        let type;
        if (typeof val === 'string') {
            type = VALUE_TYPES.STRING;
        }
        else if (typeof val === 'number') {
            type = VALUE_TYPES.NUMBER;
        }
        else if (typeof val === 'boolean') {
            type = VALUE_TYPES.BOOLEAN;
        }
        else if (val instanceof Array) {
            type = VALUE_TYPES.ARRAY;
        }
        else if (typeof val === 'object') {
            if ('type' in val) {
                type = val.type;
                val = val.value;
                if (type === VALUE_TYPES.DATETIME) {
                    val = new Date(val);
                }
                else if (type === VALUE_TYPES.REFERENCE) {
                    val = new PathReference(val);
                }
            }
            else {
                type = VALUE_TYPES.OBJECT;
            }
        }
        else {
            throw new Error(`Unknown value type`);
        }
        return { type, value: val };
    }


    /**
     * Creates or updates a node in its own record. DOES NOT CHECK if path exists in parent node, or if parent paths exist! Calling code needs to do this
     * @param {string} path 
     * @param {any} value 
     * @param {object} [options] 
     * @param {CustomStorageTransaction} [options.transaction] TODO: implement
     * @returns {Promise<void>}
     */
    async _writeNode(path, value, options = { merge: false, revision: null, transaction: null }) {
        if (this.valueFitsInline(value) && path !== '') {
            throw new Error(`invalid value to store in its own node`);
        }
        else if (path === '' && (typeof value !== 'object' || value instanceof Array)) {
            throw new Error(`Invalid root node value. Must be an object`);
        }
        
        // Get info about current node at path
        const currentRow = await this._readNode(path);
        const newRevision = (options && options.revision) || ID.generate();
        let mainNode = {
            type: VALUE_TYPES.OBJECT,
            value: {}
        };
        const childNodeValues = {};
        if (value instanceof Array) {
            mainNode.type = VALUE_TYPES.ARRAY;
            // Convert array to object with numeric properties
            const obj = {};
            for (let i = 0; i < value.length; i++) {
                obj[i] = value[i];
            }
            value = obj;
        }
        else if (value instanceof PathReference) {
            mainNode.type = VALUE_TYPES.REFERENCE;
            mainNode.value = value.path;
        }
        else if (value instanceof ArrayBuffer) {
            mainNode.type = VALUE_TYPES.BINARY;
            mainNode.value = ascii85.encode(value);
        }
        else if (typeof value === 'string') {
            mainNode.type = VALUE_TYPES.STRING;
            mainNode.value = value;
        }

        const currentIsObjectOrArray = currentRow ? [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(currentRow.type) : false;
        const newIsObjectOrArray = [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(mainNode.type);
        const children = {
            current: [],
            new: []
        }

        let currentObject = null;
        if (currentIsObjectOrArray) {
            currentObject = currentRow.value;
            children.current = Object.keys(currentObject);
            // if (currentObject instanceof Array) { // ALWAYS FALSE BECAUSE THEY ARE STORED AS OBJECTS WITH NUMERIC PROPERTIES
            //     // Convert array to object with numeric properties
            //     const obj = {};
            //     for (let i = 0; i < value.length; i++) {
            //         obj[i] = value[i];
            //     }
            //     currentObject = obj;
            // }
            if (newIsObjectOrArray) {
                mainNode.value = currentObject;
            }
        }
        if (newIsObjectOrArray) {
            // Object or array. Determine which properties can be stored in the main node, 
            // and which should be stored in their own nodes
            Object.keys(value).forEach(key => {
                const val = value[key];
                delete mainNode.value[key]; // key is being overwritten, moved from inline to dedicated, or deleted. TODO: check if this needs to be done SQLite & MSSQL implementations too
                if (val === null) { //  || typeof val === 'undefined'
                    // This key is being removed
                    return;
                }
                else if (typeof val === "undefined") {
                    if (this.settings.removeVoidProperties === true) {
                        delete value[key]; // Kill the property in the passed object as well, to prevent differences in stored and working values
                        return;
                    }
                    else {
                        throw new Error(`Property "${key}" has invalid value. Cannot store undefined values. Set removeVoidProperties option to true to automatically remove undefined properties`);
                    }
                }
                // Where to store this value?
                if (this.valueFitsInline(val)) {
                    // Store in main node
                    mainNode.value[key] = val;
                }
                else {
                    // Store in child node
                    childNodeValues[key] = val;
                }
            });
        }

        // Insert or update node
        if (currentRow) {
            // update
            this.debug.log(`Node "/${path}" is being ${options.merge ? 'updated' : 'overwritten'}`.cyan);

            // If existing is an array or object, we have to find out which children are affected
            if (currentIsObjectOrArray || newIsObjectOrArray) {

                // Get current child nodes in dedicated child records
                const pathInfo = PathInfo.get(path);
                const keys = [];
                let checkExecuted = false;
                const includeChildCheck = childPath => {
                    checkExecuted = true;
                    if (!pathInfo.isParentOf(childPath)) {
                        // Double check failed
                        throw new Error(`"${childPath}" is not a child of "${path}" - childrenOf must only check and return paths that are children`);
                    }
                    return true;
                }
                const addChildPath = childPath => {
                    if (!checkExecuted) {
                        throw new Error(`${this._customImplementation.info} childrenOf did not call checkCallback before addCallback`);
                    }
                    const key = PathInfo.get(childPath).key;
                    keys.push(key);
                    return true; // Keep streaming
                }
                await this._customImplementation.childrenOf(path, { metadata: false, value: false }, includeChildCheck, addChildPath);
                
                children.current = children.current.concat(keys);
                if (newIsObjectOrArray) {
                    if (options && options.merge) {
                        children.new = children.current.slice();
                    }
                    Object.keys(value).forEach(key => {
                        if (!children.new.includes(key)) {
                            children.new.push(key);
                        }
                    });
                }

                const changes = {
                    insert: children.new.filter(key => !children.current.includes(key)),
                    update: children.new.filter(key => children.current.includes(key)),
                    delete: options && options.merge ? Object.keys(value).filter(key => value[key] === null) : children.current.filter(key => !children.new.includes(key)),
                };

                // (over)write all child nodes that must be stored in their own record
                const writePromises = Object.keys(childNodeValues).map(key => {
                    const childPath = pathInfo.childPath(key); // PathInfo.getChildPath(path, key);
                    const childValue = childNodeValues[key];
                    return this._writeNode(childPath, childValue, { revision: newRevision, merge: false });
                });

                // Delete all child nodes that were stored in their own record, but are being removed 
                // Also delete nodes that are being moved from a dedicated record to inline
                const movingNodes = keys.filter(key => key in mainNode.value); // moving from dedicated to inline value
                const deleteDedicatedKeys = changes.delete.concat(movingNodes);
                const deletePromises = deleteDedicatedKeys.map(key => {
                    const childPath = pathInfo.childPath(key); //PathInfo.getChildPath(path, key);
                    return this._deleteNode(childPath);
                });

                const promises = writePromises.concat(deletePromises);
                await Promise.all(promises);
            }

            // Update main node
            return await this._storeNode(path, {
                type: mainNode.type,
                value: mainNode.value,
                revision: currentRow.revision,
                revision_nr: currentRow.revision_nr + 1,
                created: currentRow.created,
                modified: Date.now()
            });
        }
        else {
            // Current node does not exist, create it and any child nodes
            // write all child nodes that must be stored in their own record
            this.debug.log(`Node "/${path}" is being created`.cyan);

            const promises = Object.keys(childNodeValues).map(key => {
                const childPath = PathInfo.getChildPath(path, key);
                const childValue = childNodeValues[key];
                return this._writeNode(childPath, childValue, { revision: newRevision, merge: false });
            });

            // Create current node
            const p = this._storeNode(path, {
                type: mainNode.type,
                value: mainNode.value,
                revision: newRevision,
                revision_nr: 1,
                created: Date.now(),
                modified: Date.now()
            });
            promises.push(p);
            return Promise.all(promises);
        }
    }

    /**
     * Deletes (dedicated) node and all subnodes without checking for existence. Use with care - all removed nodes will lose their revision stats! DOES NOT REMOVE INLINE CHILD NODES!
     * @param {string} path 
     */
    async _deleteNode(path) {
        const pathInfo = PathInfo.get(path);
        this.debug.log(`Node "/${path}" is being deleted`.cyan);

        const deletePaths = [path];
        let checkExecuted = false;
        const includeDescendantCheck = (descPath) => {
            checkExecuted = true;
            if (!pathInfo.isAncestorOf(descPath)) {
                // Double check failed
                throw new Error(`"${descPath}" is not a descendant of "${path}" - descendantsOf must only check and return paths that are descendants`);
            }
            return true;        
        };
        const addDescendant = (descPath) => {
            if (!checkExecuted) {
                throw new Error(`${this._customImplementation.info} descendantsOf did not call checkCallback before addCallback`);
            }
            deletePaths.push(descPath);
            return true;
        };
        await this._customImplementation.descendantsOf(path, { metadata: false, value: false }, includeDescendantCheck, addDescendant);

        this.debug.log(`Nodes ${deletePaths.map(p => `"/${p}"`).join(',')} are being deleted`.cyan);
        return this._customImplementation.removeMultiple(deletePaths);
    }

    /**
     * Enumerates all children of a given Node for reflection purposes
     * @param {string} path 
     * @param {string[]|number[]} [options.keyFilter]
     */
    getChildren(path, options = { keyFilter: undefined, tid: undefined }) {
        // return generator
        var callback; //, resolve, reject;
        const generator = {
            /**
             * 
             * @param {(child: NodeInfo) => boolean} valueCallback callback function to run for each child. Return false to stop iterating
             * @returns {Promise<bool>} returns a promise that resolves with a boolean indicating if all children have been enumerated, or was canceled by the valueCallback function
             */
            next(valueCallback) {
                callback = valueCallback;
                return start();
            }
        };
        const start = () => {
            let lock, canceled = false;
            const tid = (options && options.tid) || ID.generate();
            return this.nodeLocker.lock(path, tid, false, 'getChildren')
            .then(async l => {
                lock = l;

                let node = await this._readNode(path);
                if (!node) { throw new NodeNotFoundError(`Node "/${path}" does not exist`); }
                // node = JSON.parse(node);

                if (![VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(node.type)) {
                    // No children
                    return;
                }
                const isArray = node.type === VALUE_TYPES.ARRAY;
                const value = node.value;
                let keys = Object.keys(value);
                if (options.keyFilter) {
                    keys = keys.filter(key => options.keyFilter.includes(key));
                }
                const pathInfo = PathInfo.get(path);
                keys.length > 0 && keys.every(key => {
                    let child = this._getTypeFromStoredValue(value[key]);

                    const info = new CustomStorageNodeInfo({
                        path: pathInfo.childPath(key),
                        key: isArray ? null : key,
                        index: isArray ? key : null,
                        type: child.type,
                        address: null,
                        exists: true,
                        value: child.value,
                        revision: node.revision,
                        revision_nr: node.revision_nr,
                        created: node.created,
                        modified: node.modified
                    });

                    canceled = callback(info) === false;
                    return !canceled; // stop .every loop if canceled
                });
                if (canceled) {
                    return;
                }

                // Go on... get other children
                let checkExecuted = false;
                const includeChildCheck = (childPath) => {
                    checkExecuted = true;
                    if (!pathInfo.isParentOf(childPath)) {
                        // Double check failed
                        throw new Error(`"${childPath}" is not a child of "${path}" - childrenOf must only check and return paths that are children`);
                    }
                    if (options.keyFilter) {
                        const key = PathInfo.get(childPath).key;
                        return options.keyFilter.includes(key);
                    }
                    return true;           
                };

                /**
                 * 
                 * @param {string} childPath 
                 * @param {ICustomStorageNodeMetaData} node 
                 */
                const addChildNode = (childPath, node) => {
                    if (!checkExecuted) {
                        throw new Error(`${this._customImplementation.info} childrenOf did not call checkCallback before addCallback`);
                    }
                    const key = PathInfo.get(childPath).key;
                    const info = new CustomStorageNodeInfo({
                        path: childPath,
                        type: node.type,
                        key: isArray ? null : key,
                        index: isArray ? key : null,
                        address: new CustomStorageNodeAddress(childPath),
                        exists: true,
                        value: null, // not loaded
                        revision: node.revision,
                        revision_nr: node.revision_nr,
                        created: new Date(node.created),
                        modified: new Date(node.modified)
                    });

                    canceled = callback(info) === false;
                    return !canceled;
                };
                return this._customImplementation.childrenOf(path, { metadata: true, value: false }, includeChildCheck, addChildNode);
            })
            .then(() => {
                lock.release();
                return canceled;
            })
            .catch(err => {
                lock.release();
                throw err;
            });            
        }; // start()
        return generator;
    }

    getNode(path, options = { include: undefined, exclude: undefined, child_objects: true, tid: undefined }) {
        // path = path.replace(/'/g, '');  // prevent sql injection, remove single quotes

        const tid = (options && options.tid )|| ID.generate();
        let lock;
        return this.nodeLocker.lock(path, tid, false, 'getNode')
        .then(async l => {
            lock = l;

            // Get path, path/* and path[*
            const filtered = options && (options.include || options.exclude || options.child_objects === false);
            const pathInfo = PathInfo.get(path);
            const targetNode = await this._readNode(path);
            if (!targetNode) {
                // Lookup parent node
                if (path === '') { return { value: null }; } // path is root. There is no parent.
                return lock.moveToParent()
                .then(async parentLock => {
                    lock = parentLock;
                    let parentNode = await this._readNode(pathInfo.parentPath);
                    if (parentNode && [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(parentNode.type) && pathInfo.key in parentNode) {
                        const childValueInfo = this._getTypeFromStoredValue(parentNode.value[pathInfo.key]);
                        return { 
                            revision: parentNode.revision, 
                            revision_nr: parentNode.revision_nr,
                            created: parentNode.created,
                            modified: parentNode.modified,
                            type: childValueInfo.type,
                            value: childValueInfo.value
                        };
                    }
                    return { value: null };
                });
            }

            const includeCheck = options.include 
                ? new RegExp('^' + options.include.map(p => '(?:' + p.replace(/\*/g, '[^/\\[]+') + ')').join('|') + '(?:$|[/\\[])')
                : null;
            const excludeCheck = options.exclude 
                ? new RegExp('^' + options.exclude.map(p => '(?:' + p.replace(/\*/g, '[^/\\[]+') + ')').join('|') + '(?:$|[/\\[])')
                : null;

            let checkExecuted = false;
            const includeDescendantCheck = (descPath) => {
                checkExecuted = true;
                if (!pathInfo.isAncestorOf(descPath)) {
                    // Double check failed
                    throw new Error(`"${descPath}" is not a descendant of "${path}" - descendantsOf must only check and return paths that are descendants`);
                }
                if (!filtered) { return true; }

                // Apply include & exclude filters
                let checkPath = descPath.slice(path.length);
                if (checkPath[0] === '/') { checkPath = checkPath.slice(1); }
                let include = (includeCheck ? includeCheck.test(checkPath) : true) 
                    && (excludeCheck ? !excludeCheck.test(checkPath) : true);

                // Apply child_objects filter
                if (include 
                    && options.child_objects === false 
                    && (pathInfo.isParentOf(descPath) && [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(childNode.type)
                    || PathInfo.getPathKeys(descPath).length > pathInfo.pathKeys.length + 1)
                ) {
                    include = false;
                }
                return include;
            }

            const descRows = [];
            /**
             * 
             * @param {string} descPath 
             * @param {ICustomStorageNode} node 
             */
            const addDescendant = (descPath, node) => {
                if (!checkExecuted) {
                    throw new Error(`${this._customImplementation.info} descendantsOf did not call checkCallback before addCallback`);
                }
                
                // Process the value
                this._processReadNodeValue(node);
                
                // Add node
                node.path = descPath;
                descRows.push(node);

                return true; // Keep streaming
            };

            await this._customImplementation.descendantsOf(path, { metadata: true, value: true }, includeDescendantCheck, addDescendant);

            this.debug.log(`Read node "/${path}" and ${filtered ? '(filtered) ' : ''}children from ${descRows.length + 1} records`.magenta);

            const result = targetNode;

            const objectToArray = obj => {
                // Convert object value to array
                const arr = [];
                Object.keys(obj).forEach(key => {
                    let index = parseInt(key);
                    arr[index] = obj[index];
                });
                return arr;                
            };

            if (targetNode.type === VALUE_TYPES.ARRAY) {
                result.value = objectToArray(result.value);
            }

            if (targetNode.type === VALUE_TYPES.OBJECT || targetNode.type === VALUE_TYPES.ARRAY) {
                // target node is an object or array
                // merge with other found (child) nodes
                const targetPathKeys = PathInfo.getPathKeys(path);
                let value = targetNode.value;
                for (let i = 0; i < descRows.length; i++) {
                    const otherNode = descRows[i];
                    const pathKeys = PathInfo.getPathKeys(otherNode.path);
                    const trailKeys = pathKeys.slice(targetPathKeys.length);
                    let parent = value;
                    for (let j = 0 ; j < trailKeys.length; j++) {
                        console.assert(typeof parent === 'object', 'parent must be an object/array to have children!!');
                        const key = trailKeys[j];
                        const isLast = j === trailKeys.length-1;
                        const nodeType = isLast 
                            ? otherNode.type 
                            : typeof trailKeys[j+1] === 'number'
                                ? VALUE_TYPES.ARRAY
                                : VALUE_TYPES.OBJECT;
                        let nodeValue;
                        if (!isLast) {
                            nodeValue = nodeType === VALUE_TYPES.OBJECT ? {} : [];
                        }
                        else {
                            nodeValue = otherNode.value;
                            if (nodeType === VALUE_TYPES.ARRAY) {
                                nodeValue = objectToArray(nodeValue);
                            }
                        }
                        if (key in parent) {
                            // Merge with parent
                            console.assert(typeof parent[key] === typeof nodeValue && [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(nodeType), 'Merging child values can only be done if existing and current values are both an array or object');
                            Object.keys(nodeValue).forEach(childKey => {
                                console.assert(!(childKey in parent[key]), 'child key is in parent value already?! HOW?!');
                                parent[key][childKey] = nodeValue[childKey];
                            });
                        }
                        else {
                            parent[key] = nodeValue;
                        }
                        parent = parent[key];
                    }
                }
            }
            else if (descRows.length > 0) {
                throw new Error(`multiple records found for non-object value!`);
            }

            // Post process filters to remove any data that got though because they were
            // not stored in dedicated records. This will happen with smaller values because
            // they are stored inline in their parent node.
            // eg:
            // { number: 1, small_string: 'small string', bool: true, obj: {}, arr: [] }
            // All properties of this object are stored inline, 
            // if exclude: ['obj'], or child_objects: false was passed, these will still
            // have to be removed from the value

            if (options.child_objects === false) {
                Object.keys(result.value).forEach(key => {
                    if (typeof result.value[key] === 'object' && result.value[key].constructor === Object) {
                        // This can only happen if the object was empty
                        console.assert(Object.keys(result.value[key]).length === 0);
                        delete result.value[key];
                    }
                })
            }

            if (options.exclude) {
                const process = (obj, keys) => {
                    if (typeof obj !== 'object') { return; }
                    const key = keys[0];
                    if (key === '*') {
                        Object.keys(obj).forEach(k => {
                            process(obj[k], keys.slice(1));
                        });
                    }
                    else if (keys.length > 1) {
                        key in obj && process(obj[key], keys.slice(1));
                    }
                    else {
                        delete obj[key];
                    }
                };
                options.exclude.forEach(path => {
                    const checkKeys = PathInfo.getPathKeys(path);
                    process(result.value, checkKeys);
                });
            }
            return result;
        })
        .then(result => {
            lock.release();
            return result;
        })
        .catch(err => {
            lock.release();
            throw err;
        });
    }

    /**
     * 
     * @param {string} path 
     * @param {*} options 
     * @returns {Promise<CustomStorageNodeInfo>}
     */
    getNodeInfo(path, options = { tid: undefined }) {
        const pathInfo = PathInfo.get(path);
        const tid = (options && options.tid) || ID.generate();
        let lock;
        return this.nodeLocker.lock(path, tid, false, 'getNodeInfo')
        .then(async l => {
            lock = l;

            const node = await this._readNode(path);
            const info = new CustomStorageNodeInfo({ 
                path, 
                key: typeof pathInfo.key === 'string' ? pathInfo.key : null,
                index: typeof pathInfo.key === 'number' ? pathInfo.key : null,
                type: node ? node.type : 0, 
                exists: node !== null,
                address: node ? new CustomStorageNodeAddress(path) : null,
                created: node ? new Date(node.created) : null,
                modified: node ? new Date(node.modified) : null,
                revision: node ? node.revision : null,
                revision_nr: node ? node.revision_nr : null
            });

            if (node || path === '') {
                return info;
            }

            // Try parent node
            return lock.moveToParent()
            .then(async parentLock => {
                lock = parentLock;
                const parent = await this._readNode(pathInfo.parentPath);
                if (parent && [VALUE_TYPES.OBJECT, VALUE_TYPES.ARRAY].includes(parent.type) && pathInfo.key in parent.value) {
                    // Stored in parent node
                    info.exists = true;
                    info.value = parent.value[pathInfo.key];
                    info.address = null;
                    info.type = parent.type;
                    info.created = new Date(parent.created);
                    info.modified = new Date(parent.modified);
                    info.revision = parent.revision;
                    info.revision_nr = parent.revision_nr;
                }
                else {
                    // Parent doesn't exist, so the node we're looking for cannot exist either
                    info.address = null;
                }
                return info;
            })
        })
        .then(info => {
            lock.release();
            return info;
        })
        .catch(err => {
            lock && lock.release();
            throw err;
        });
    }

    // TODO: Move to Storage base class?
    removeNode(path, options = { tid: undefined }) {
        if (path === '') { 
            return Promise.reject(new Error(`Cannot remove the root node`)); 
        }
        
        const pathInfo = PathInfo.get(path);
        const tid = (options && options.tid) || ID.generate();
        return this.nodeLocker.lock(pathInfo.parentPath, tid, true, 'removeNode')
        .then(lock => {
            return this.updateNode(pathInfo.parentPath, { [pathInfo.key]: null }, { tid })
            .then(result => {
                lock.release();
                return result;
            })
            .catch(err => {
                lock.release();
                throw err;
            });            
        });
    }

    // TODO: Move to Storage base class?
    setNode(path, value, options = { assert_revision: undefined, tid: undefined }) {        
        const pathInfo = PathInfo.get(path);

        let lock;
        const tid = (options && options.tid) || ID.generate();
        return this.nodeLocker.lock(path, tid, true, 'setNode')
        .then(l => {
            lock = l;

            if (path === '') {
                if (value === null || typeof value !== 'object' || value instanceof Array || value instanceof ArrayBuffer || ('buffer' in value && value.buffer instanceof ArrayBuffer)) {
                    return Promise.reject(new Error(`Invalid value for root node: ${value}`));
                }

                return this._writeNodeWithTracking('', value, { merge: false, tid })
            }

            if (options && typeof options.assert_revision !== 'undefined') {
                return this.getNodeInfo(path, { tid: lock.tid })
                .then(info => {
                    if (info.revision !== options.assert_revision) {
                        throw new NodeRevisionError(`revision '${info.revision}' does not match requested revision '${options.assert_revision}'`);
                    }
                    if (info.address && info.address.path === path && !this.valueFitsInline(value)) {
                        // Overwrite node
                        return this._writeNodeWithTracking(path, value, { merge: false, tid });
                    }
                    else {
                        // Update parent node
                        return lock.moveToParent()
                        .then(parentLock => {
                            lock = parentLock;
                            return this._writeNodeWithTracking(pathInfo.parentPath, { [pathInfo.key]: value }, { merge: true, tid });
                        });
                    }
                })
            }
            else {
                // Delegate operation to update on parent node
                return lock.moveToParent()
                .then(parentLock => {
                    lock = parentLock;                
                    return this.updateNode(pathInfo.parentPath, { [pathInfo.key]: value }, { tid });
                });
            }
        })
        .then(result => {
            lock.release();
            return result;
        })
        .catch(err => {
            lock.release();
            throw err;
        });        
    }

    // TODO: Move to Storage base class?
    updateNode(path, updates, options = { tid: undefined }) {

        if (typeof updates !== 'object') { //  || Object.keys(updates).length === 0
            return Promise.reject(new Error(`invalid updates argument`)); //. Must be a non-empty object or array
        }

        const tid = (options && options.tid) || ID.generate();
        let lock;
        return this.nodeLocker.lock(path, tid, true, 'updateNode')
        .then(l => {
            lock = l;
            // Get info about current node
            return this.getNodeInfo(path, { tid: lock.tid });    
        })
        .then(nodeInfo => {
            const pathInfo = PathInfo.get(path);
            if (nodeInfo.exists && nodeInfo.address && nodeInfo.address.path === path) {
                // Node exists and is stored in its own record.
                // Update it
                return this._writeNodeWithTracking(path, updates, { merge: true, tid });
            }
            else if (nodeInfo.exists) {
                // Node exists, but is stored in its parent node.
                const pathInfo = PathInfo.get(path);
                return lock.moveToParent()
                .then(parentLock => {
                    lock = parentLock;
                    return this._writeNodeWithTracking(pathInfo.parentPath, { [pathInfo.key]: value }, { merge: true, tid });
                });
            }
            else {
                // The node does not exist, it's parent doesn't have it either. Update the parent instead
                return lock.moveToParent()
                .then(parentLock => {
                    lock = parentLock;
                    return this.updateNode(pathInfo.parentPath, { [pathInfo.key]: updates }, { tid });
                });
            }
        })
        .then(result => {
            lock.release();
            return result;
        })
        .catch(err => {
            lock.release();
            throw err;
        });        
    }

}

module.exports = {
    CustomStorageNodeAddress,
    CustomStorageNodeInfo,
    CustomStorage,
    CustomStorageSettings,
    CustomStorageHelpers,
    ICustomStorageNodeMetaData,
    ICustomStorageNode
}