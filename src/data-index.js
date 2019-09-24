'use strict';

const { Storage } = require('./storage');
const { Node } = require('./node');
const { BPlusTreeBuilder, BPlusTree, BinaryBPlusTree, BinaryWriter, BinaryBPlusTreeLeafEntry, BinaryReader } = require('./btree');
const { PathInfo, Utils, ID, debug } = require('acebase-core');
const { compareValues, getChildValues, numberToBytes, bytesToNumber } = Utils;
const Geohash = require('./geohash');
const { TextEncoder, TextDecoder } = require('text-encoding');
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const pfs = require('./promise-fs');
const fs = require('fs');
const ThreadSafe = require('./thread-safe');

const DISK_BLOCK_SIZE = 4096; // use 512 for older disks
const FILL_FACTOR = 50; // leave room for inserts

function _createRecordPointer(wildcards, key) { //, address) {
    // binary layout:
    // record_pointer   = wildcards_info, key_info, DEPRECATED: record_location
    // wildcards_info   = wildcards_length, wildcards
    // wildcards_length = 1 byte (nr of wildcard values)
    // wildcards        = wilcard[wildcards_length]
    // wildcard         = wilcard_length, wilcard_bytes
    // wildcard_length  = 1 byte
    // wildcard_value   = byte[wildcard_length] (ASCII char codes)
    // key_info         = key_length, key_bytes
    // key_length       = 1 byte
    // key_bytes        = byte[key_length] (ASCII char codes)
    // NOT USED, DEPRECATED:
    // record_location  = page_nr, record_nr
    // page_nr          = 4 byte number
    // record_nr        = 2 byte number

    let recordPointer = [wildcards.length]; // wildcards_length
    for (let i = 0; i < wildcards.length; i++) {
        const wildcard = wildcards[i];
        recordPointer.push(wildcard.length); // wildcard_length
        // wildcard_bytes:
        for (let j = 0; j < wildcard.length; j++) {
            recordPointer.push(wildcard.charCodeAt(j));
        }
    }
    
    recordPointer.push(key.length); // key_length
    // key_bytes:
    for (let i = 0; i < key.length; i++) {
        recordPointer.push(key.charCodeAt(i));
    }
    // // page_nr:
    // recordPointer.push((address.pageNr >> 24) & 0xff);
    // recordPointer.push((address.pageNr >> 16) & 0xff);
    // recordPointer.push((address.pageNr >> 8) & 0xff);
    // recordPointer.push(address.pageNr & 0xff);
    // // record_nr:
    // recordPointer.push((address.recordNr >> 8) & 0xff);
    // recordPointer.push(address.recordNr & 0xff);
    return recordPointer;
};

function _parseRecordPointer(path, recordPointer) {
    if (recordPointer.length === 0) {
        throw new Error(`Invalid record pointer length`);
    }
    const wildcardsLength = recordPointer[0];
    let wildcards = [];
    let index = 1;
    for (let i = 0; i < wildcardsLength; i++) {
        let wildcard = "";
        let length = recordPointer[index];
        for (let j = 0; j < length; j++) {
            wildcard += String.fromCharCode(recordPointer[index+j+1]);
        }
        wildcards.push(wildcard);
        index += length + 1;
    }
    const keyLength = recordPointer[index];
    let key = "";
    for(let i = 0; i < keyLength; i++) {
        key += String.fromCharCode(recordPointer[index+i+1]);
    }
    index += keyLength + 1;

    // const pageNr = recordPointer[index] << 24 | recordPointer[index+1] << 16 | recordPointer[index+2] << 8 | recordPointer[index+3];
    // index += 4;
    // const recordNr = recordPointer[index] << 8 | recordPointer[index+1];
    
    if (wildcards.length > 0) {
        let i = 0;
        path = path.replace(/\*/g, () => {
            const wildcard = wildcards[i];
            i++;
            return wildcard;
        });
    }
    // return { key, pageNr, recordNr, address: new NodeAddress(`${path}/${key}`, pageNr, recordNr) };
    return { key, path: `${path}/${key}`, wildcards };
}

class DataIndex {
    /**
     * Creates a new index
     * @param {Storage} storage
     * @param {string} path 
     * @param {string} key 
     * @param {object} [options]
     * @param {boolean} [options.caseSensitive=false] if strings in the index should be indexed case-sensitive. defaults to false
     * @param {string} [options.textLocale="en"] locale to use when comparing case insensitive string values. Can be a language code ("nl", "en" etc), or LCID ("en-us", "en-au" etc). Defaults to English ("en")
     * @param {string[]} [options.include] other keys' data to include in the index, for faster sorting topN (.limit.order) query results
     */
    constructor(storage, path, key, options = {}) {
        if (['string','undefined'].indexOf(typeof options.include) < 0 && !(options.include instanceof Array)) {
            throw new Error(`includeKeys argument must be a string, an Array of strings, or undefined. Passed type=${typeof options.include}`);
        }
        if (typeof options.include === 'string') {
            options.include = [options.include];
        }

        this.storage = storage;
        this.path = path.replace(/\/\*$/, ""); // Remove optional trailing "/*"
        this.key = key;
        this.caseSensitive = options.caseSensitive === true;
        this.textLocale = options.textLocale || "en";
        this.includeKeys = options.include || [];
        // this.enableReverseLookup = false;
        this.indexMetadataKeys = [];
    
        /**
         * @type {Map<string, Map<any, BinaryBPlusTreeLeafEntry>}
         */
        this._cache = new Map();
        this.setCacheTimeout(60, true); // 1 minute query cache
        
        this.trees = {
            'default': {
                fileIndex: 0,
                byteLength: 0,
                class: 'BPlusTree',
                version: 1, // TODO: implement BinaryBPlusTree.version
                entries: 0,
                values: 0
            }
        };
    }

    setCacheTimeout(seconds, sliding = false) {
        this._cacheTimeoutSettings = {
            duration: seconds * 1000,
            sliding
        };
    }

    cache(op, val, results) {
        if (results === undefined) {
            // Get from cache
            let cache;
            if (this._cache.has(op) && this._cache.get(op).has(val)) {
                cache = this._cache.get(op).get(val);
            }
            if (cache) {
                cache.reads++;
                if (this._cacheTimeoutSettings.sliding) {
                    cache.extendLife();
                }
                return cache.results;
            }
            return null;
        }
        else {
            // Set cache
            let opCache = this._cache.get(op);
            if (!opCache) {
                opCache = new Map();
                this._cache.set(op, opCache);
            }
            let clear = () => {
                // debug.log(`Index ${this.description}, cache clean for ${op} "${val}"`);
                opCache.delete(val);
            }
            let cache = {
                results,
                added: Date.now(),
                reads: 0,
                timeout: setTimeout(clear, this._cacheTimeoutSettings.duration),
                extendLife: () => {
                    // debug.log(`Index ${this.description}, cache lifetime extended for ${op} "${val}". reads: ${cache.reads}`);
                    clearTimeout(cache.timeout);
                    cache.timeout = setTimeout(clear, this._cacheTimeoutSettings.duration);
                }
            }
            opCache.set(val, cache);            
            // debug.log(`Index ${this.description}, cached ${results.length} results for ${op} "${val}"`);
        }
    }


    static readFromFile(storage, fileName) {
        // Read an index from file
        let dataIndex;
        let fd;
        const filePath = `${storage.settings.path}/${storage.name}.acebase/${fileName}`;

        return pfs.open(filePath, pfs.flags.read)
        .then(fileDescriptor => {
            fd = fileDescriptor;
            // Read signature
            return pfs.read(fd, Buffer.alloc(10));
        })
        .then(result => {
            // Check signature
            if (result.buffer.toString() !== 'ACEBASEIDX') {
                throw new Error(`File "${filePath}" is not an AceBase index. If you get this error after updating acebase, delete the index file and rebuild it`);
            }
            // Read layout_version
            return pfs.read(fd, Buffer.alloc(1));
        })
        .then(result => {
            const versionNr = result.buffer[0];
            if (versionNr !== 1) {
                throw new Error(`Index "${filePath}" version ${versionNr} is not supported by this version of AceBase. npm update your acebase packages`);
            }
            // Read header_length
            return pfs.read(fd, Buffer.alloc(4));
        })
        .then(result => {
            const headerLength = (result.buffer[0] << 24) | (result.buffer[1] << 16) | (result.buffer[2] << 8) | result.buffer[3];
            // Read header
            return pfs.read(fd, Buffer.alloc(headerLength-11));
        })
        .then(result => {
            // Process header
            const header = Uint8Array.from(result.buffer);
            let index = 0;
            
            const readKey = () => {
                const keyLength = header[index];
                let keyName = '';
                index++;
                for (let j = 0; j < keyLength; j++) {
                    keyName += String.fromCharCode(header[index+j]);
                }
                index += keyLength;
                return keyName;
            };
            const readValue = () => {
                const valueType = header[index];
                index++;
                let valueLength = 0;
                if (valueType === 0) {
                    // UNDEFINED
                    valueLength = 0;
                }
                else if (valueType === 3) {
                    // BOOLEAN has no value_length
                    valueLength = 1;
                }
                else {
                    valueLength = (header[index] << 8) | header[index+1];
                    index += 2;
                }

                let value;
                if (valueType === 1) {
                    // STRING
                    value = textDecoder.decode(header.slice(index, index+valueLength));
                }
                else if (valueType === 2) {
                    // NUMBER
                    value = bytesToNumber(header.slice(index, index+valueLength));
                }
                else if (valueType === 3) {
                    // BOOLEAN
                    value = header[index] === 1;
                }
                else if (valueType === 4) {
                    // ARRAY
                    let arr = [];
                    for (let j = 0; j < valueLength; j++) {
                        arr.push(readValue());
                    }
                    return arr;
                }
                index += valueLength;
                return value;
            };
            const readInfo = () => {
                const infoCount = header[index];
                index++;
                const info = {};
                for (let i = 0; i < infoCount; i++) {
                    const key = readKey();                    
                    const value = readValue();
                    info[key] = value;
                }
                return info;
            };

            const indexInfo = readInfo();
            let indexOptions = { caseSensitive: indexInfo.cs, textLocale: indexInfo.locale, include: indexInfo.include };
            switch (indexInfo.type) {
                case 'normal': {
                    dataIndex = new DataIndex(storage, indexInfo.path, indexInfo.key, indexOptions); 
                    break;
                }
                case 'array': {
                    dataIndex = new ArrayIndex(storage, indexInfo.path, indexInfo.key, indexOptions); 
                    break;
                }
                case 'fulltext': {
                    dataIndex = new FullTextIndex(storage, indexInfo.path, indexInfo.key, indexOptions); 
                    break;
                }
                case 'geo': {
                    dataIndex = new GeoIndex(storage, indexInfo.path, indexInfo.key, indexOptions); 
                    break;
                }
                default: {
                    throw new Error(`Unknown index type ${indexInfo.type}`);
                }
            }
            dataIndex._fileName = filePath;

            // trees_info:
            const treesCount = header[index];
            index++;
            for (let i = 0; i < treesCount; i++) {
                // tree_name:
                const treeName = readKey();
                // treeName is "default"
                const treeInfo = dataIndex.trees[treeName] = {};
                // file_index:
                treeInfo.fileIndex = (header[index] << 24) | (header[index+1] << 16) | (header[index+2] << 8) | header[index+3];
                index += 4;
                // byte_length:
                treeInfo.byteLength = (header[index] << 24) | (header[index+1] << 16) | (header[index+2] << 8) | header[index+3];
                index += 4;

                const info = readInfo();
                // info has: class, version, entries, values
                Object.assign(treeInfo, info); //treeInfo.info = info;
            }

            return pfs.close(fd);
        })
        .catch(err => {
            pfs.close(fd);
            throw err;
        })
        .then(() => {
            return dataIndex;
        });
    }

    get type() {
        return 'normal';
    }

    get fileName() {
        if (this._fileName) { return this._fileName; }
        const dir = `${this.storage.settings.path}/${this.storage.name}.acebase`;
        const escapedPath = this.path.replace(/\//g, '-').replace(/\*/g, '#');
        const includes = this.includeKeys.length > 0 
            ? ',' + this.includeKeys.join(',')
            : '';
        const extension = (this.type !== 'normal' ? `${this.type}.` : '') + 'idx';
        return `${dir}/${escapedPath}-${this.key}${includes}.${extension}`;        
    }

    get description() {
        const keyPath = `/${this.path}/*/${this.key}`;
        const includedKeys = this.includeKeys.length > 0 ? '+' + this.includeKeys.join(',') : '';
        let description = `${keyPath}${includedKeys}`;
        if (this.type !== 'normal') {
            description += ` (${this.type})`;
        }
        return description;
    }

    _getWildcardKeys(path) {
        const pathKeys = PathInfo.getPathKeys(path);
        const indexKeys = PathInfo.getPathKeys(this.path);
        return indexKeys.reduce((wildcards, key, i) => {
            if (key === '*') { wildcards.push(pathKeys[i]); }
            return wildcards;
        }, []);
    }

    // _getRevLookupKey(path) {
    //     const key = getPathInfo(path).key;
    //     const wildcardKeys = this._getWildcardKeys(path);
    //     return `:${wildcardKeys.join(':')}${wildcardKeys.length > 0 ? ':' : ''}${key}:`;
    // }

    // _updateReverseLookupKey(path, oldData, newData, metadata) {
    //     if (!this.enableReverseLookup) {
    //         throw new Error(`This index does not support reverse lookups`)
    //     }
    //     function areEqual(val1, val2) {
    //         return val1.length === val2.length && val1.every((byte, index) => val2[index] === byte);
    //     }
    //     if (areEqual(oldData, newData)) {
    //         // Everything remains the same
    //         return;
    //     }
    //     const revLookupKey = this._getRevLookupKey(path);
    //     return this._updateTree(path, revLookupKey, revLookupKey, oldData, newData, metadata);
    // }

    _updateTree(path, oldValue, newValue, oldRecordPointer, newRecordPointer, metadata) {
        const canBeIndexed = ['number','boolean','string'].indexOf(typeof newValue) >= 0 || newValue instanceof Date;
        const operations = [];
        if (oldValue !== null) {
            let op = BinaryBPlusTree.TransactionOperation.remove(oldValue, oldRecordPointer);
            operations.push(op);
        }
        if (newValue !== null && canBeIndexed) {
            let op = BinaryBPlusTree.TransactionOperation.add(newValue, newRecordPointer, metadata);
            operations.push(op);
        }

        return this._processTreeOperations(path, operations);
    }

    /**
     * @param {BinaryBPlusTree} tree
     */
    _rebuild() {
        // NEW: Rebuild with streams
        const newIndexFile = this.fileName + '.tmp';
        return pfs.open(newIndexFile, pfs.flags.write)
        .then(fd => {
            const treeStatistics = {};
            const headerStats = {
                written: false,
                length: 0,
                promise: null
            };

            const writer = (data, index) => { 
                let go = () => {
                    return pfs.write(fd, data, 0, data.length, headerStats.length + index);
                };
                if (!headerStats.written) {
                    // Write header first, or wait until done
                    let promise = 
                        headerStats.promise
                        || this._writeIndexHeader(fd, treeStatistics)
                        .then(result => {
                            headerStats.written = true;
                            headerStats.length = result.length;
                            headerStats.updateTreeLength = result.treeLengthCallback;
                        });
                    headerStats.promise = promise.then(go); // Chain to original promise
                    return headerStats.promise;
                }
                else {
                    return go();
                }
            }
            return this._getTree()
            .then(idx => {
                return idx.tree.rebuild(
                    BinaryWriter.forFunction(writer), 
                    { treeStatistics }
                )
                .then(() => {
                    idx.close(true);
                    return headerStats.updateTreeLength(treeStatistics.byteLength);
                })
                .then(() => {
                    return pfs.close(fd);
                })
                .then(() => {
                    // rename new file, overwriting the old file
                    return pfs.rename(newIndexFile, this.fileName);
                })
                // .then(() => {
                //     // (optional) truncate the file
                //     let totalSize = headerStats.length + treeStatistics.byteLength;
                //     pfs.truncate(this.fileName, totalSize);
                // });
            })
        });
    }

    /**
     * @param {string} path
     * @param {BinaryBPlusTreeTransactionOperation[]}
     */
    _processTreeOperations(path, operations) {
        const startTime = Date.now();
        let lock;
        return this._lock(true, `index.handleRecordUpdate "/${path}"`)
        .then(l => {
            // debug.log(`Got update lock on index ${this.description}`.blue, l);
            lock = l;
            return this._getTree();
        })
        .then(idx => {
            /**
             * @type BinaryBPlusTree
             */
            const tree = idx.tree;
            // const oldEntry = tree.find(keyValues.oldValue);
            
            return tree.transaction(operations)
            .then(() => {
                // Index updated
                idx.close();
                return false; // "not rebuilt"
            })
            .catch(err => {
                // Could not update index --> leaf full?
                debug.log(`Could not update index ${this.description}: ${err.message}`.yellow);

                idx.close();
                return this._rebuild()
                .then(() => {
                    return true; // "rebuilt"
                });

                // // OLD: Rebuild it by getting current content
                // return tree.toTreeBuilder(FILL_FACTOR) 
                // .then(builder => {
                //     idx.close();

                //     // Process left-over operations:
                //     operations.forEach(op => {
                //         if (op.type === 'add') {
                //             builder.add(op.key, op.recordPointer, op.metadata);
                //         }
                //         else if (op.type === 'update') {
                //             builder.remove(op.key, op.recordPointer);
                //             builder.add(op.key, op.recordPointer, op.metadata);
                //         }
                //         else if (op.type === 'remove') {
                //             builder.remove(op.key, op.recordPointer);
                //         }
                //     });
                //     return this._writeIndex(builder);
                // })
                // .then(() => {
                //     return true; // rebuilt
                // })
                // .catch(err => {
                //     debug.error(err);
                //     throw err;
                // });
            })
        })
        .then(rebuilt => {
            // debug.log(`Released update lock on index ${this.description}`.blue);
            lock.release();
            const doneTime = Date.now();
            const duration = Math.round((doneTime - startTime) / 1000);
            debug.log(`Index ${this.description} was ${rebuilt ? 'rebuilt' : 'updated'} successfully for "/${path}", took ${duration} seconds`.green);
            if (operations.length > 0) {
                // Process left-over operations
                return this._processTreeOperations(path, operations);
            }
        });
    }

    /**
     * 
     * @param {string} path 
     * @param {any} oldValue 
     * @param {any} newValue 
     */
    handleRecordUpdate(path, oldValue, newValue, indexMetadata) {

        const pathKey = PathInfo.get(path).key;
        const keyValues = this.key === '{key}' 
            ? { oldValue: oldValue === null ? null : pathKey, newValue: newValue === null ? null : pathKey }
            : getChildValues(this.key, oldValue, newValue);

        const includedValues = this.includeKeys.map(key => getChildValues(key, oldValue, newValue));
        if (!this.caseSensitive) {
            // Convert to locale aware lowercase
            const allValues = [keyValues].concat(includedValues);
            allValues.forEach(values => {
                if (typeof values.oldValue === 'string') { values.oldValue = values.oldValue.toLocaleLowerCase(this.textLocale); }
                if (typeof values.newValue === 'string') { values.newValue = values.newValue.toLocaleLowerCase(this.textLocale); }
            });
        }
        const keyValueChanged = compareValues(keyValues.oldValue, keyValues.newValue) !== 'identical';
        const includedValuesChanged = includedValues.some(values => compareValues(values.oldValue, values.newValue) !== 'identical');

        if (!keyValueChanged && !includedValuesChanged) {
            return;
        }

        const updatedKey = PathInfo.get(path).key;
        const wildcardKeys = this._getWildcardKeys(path);
        const recordPointer = _createRecordPointer(wildcardKeys, updatedKey);
        const metadata = (() => {
            const obj = {};
            indexMetadata && Object.assign(obj, indexMetadata);
            this.includeKeys.forEach(key => obj[key] = newValue[key]);
            return obj;
        })();

        // Invalidate query cache
        this._cache.clear();

        return this._updateTree(path, keyValues.oldValue, keyValues.newValue, recordPointer, recordPointer, metadata);
    }

    _lock(forWriting, comment) {
        if (!this._lockQueue) { this._lockQueue = []; }
        if (!this._lockState) {
            this._lockState = {
                isLocked: false,
                forWriting: undefined,
                comment: undefined
            };
        }

        const lock = { forWriting, comment, release: comment => {
            const pending = [];
            while (true) {
                if (this._lockQueue.length === 0) { break; }
                const next = this._lockQueue[0];
                if (next.forWriting) { 
                    if (pending.length === 0) {
                        pending.push(next);
                        this._lockQueue.shift();
                    }
                    break;
                }
                else {
                    pending.push(next);
                    this._lockQueue.shift();
                }
            }
            if (pending.length === 0) {
                this._lockState.isLocked = false;
                this._lockState.forWriting = undefined;
                this._lockState.comment = undefined;
            }
            else {
                this._lockState.forWriting = pending[0].forWriting;
                this._lockState.comment = '';
            }
            for (let i = 0; i < pending.length; i++) {
                const lock = pending[i];
                if (this._lockState.comment.length > 0) { this._lockState.comment += ' && '}
                this._lockState.comment += lock.comment;
                lock.resolve(lock);
            }
        }};
        if (this._lockState.isLocked) {
            // Queue lock request
            this._lockQueue.push(lock);
            return new Promise(resolve => {
                lock.resolve = resolve;
            });
        }
        else {
            // No current lock, allow
            this._lockState.isLocked = true;
            this._lockState.forWriting = forWriting;
            this._lockState.comment = comment;
            return Promise.resolve(lock);
        }
    }

    count(op, val) {
        if (!this.caseSensitive) {
            // Convert to locale aware lowercase
            if (typeof val === 'string') { val = val.toLocaleLowerCase(this.textLocale); }
            else if (val instanceof Array) {
                val = val.map(val => {
                    if (typeof val === 'string') { return val.toLocaleLowerCase(this.textLocale); }
                    return val;
                });
            }
        }
        let lock;
        return this._lock(false, `index.count "${op}", ${val}`)
        .then(l => {
            // debug.log(`Got query lock on index ${this.description}`.blue, l);
            lock = l;
            return this._getTree();
        })
        .then(idx => {
            /** @type BinaryBPlusTree */
            const tree = idx.tree;
            return tree.search(op, val, { count: true, keys: true, values: false })
            .then(result => {
                lock.release();
                idx.close();
                return result.valueCount;                
            });
        });
    }

    take(skip, take, ascending) {
        var lock;
        // debug.log(`Requesting query lock on index ${this.description}`.blue);
        return this._lock(false, `index.take ${take}, skip ${skip}, ${ascending ? 'ascending' : 'descending'}`)
        .then(l => {
            // debug.log(`Got query lock on index ${this.description}`.blue, l);
            lock = l;
            return this._getTree();
        })
        .then(idx => {
            /**
             * @type BinaryBPlusTree
             */
            const tree = idx.tree;
            const results = new IndexQueryResults(); //[];
            results.filterKey = this.key;
            let skipped = 0;
            const processLeaf = (leaf) => {
                if (!ascending) { leaf.entries.reverse(); }
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    const value = entry.key;
                    for (let j = 0; j < entry.values.length; j++) {
                        if (skipped < skip) { 
                            skipped++; 
                            continue; 
                        }
                        const entryValue = entry.values[j];
                        const recordPointer = _parseRecordPointer(this.path, entryValue.recordPointer);
                        const metadata = entryValue.metadata;
                        const result = new IndexQueryResult(recordPointer.key, recordPointer.path, value, metadata);
                        results.push(result);
                        if (results.length === take) { 
                            return results;
                        }
                    }
                }

                if (ascending && leaf.getNext) {
                    return leaf.getNext().then(processLeaf);
                }
                else if (!ascending && leaf.getPrevious) {
                    return leaf.getPrevious().then(processLeaf);
                }
                else {
                    return results;
                }
            }
            const promise = ascending 
                ? tree.getFirstLeaf().then(processLeaf)
                : tree.getLastLeaf().then(processLeaf);

            return promise.then(results => {
                lock.release();
                idx.close();
                return results;
            })
        });
    }

    static get validOperators() {
        return ['<','<=','==','!=','>=','>','exists','!exists','between','!between','like','!like','matches','!matches','in','!in'];
    }
    get validOperators() {
        return DataIndex.validOperators;
    }

    /**
     * 
     * @param {string} op 
     * @param {any} val 
     * @param {object} [options]
     * @param {IndexQueryResults} [options.filter=undefined] previous results to filter upon
     * @returns {Promise<IndexQueryResults>}
     */
    query(op, val, options = { filter: undefined }) {
        if (DataIndex.validOperators.indexOf(op) < 0) {
            throw new TypeError(`Cannot use operator "${op}" to query index "${this.description}"`);
        }
        if (!this.caseSensitive) {
            // Convert to locale aware lowercase
            if (typeof val === 'string') { val = val.toLocaleLowerCase(this.textLocale); }
            else if (val instanceof Array) {
                val = val.map(val => {
                    if (typeof val === 'string') { return val.toLocaleLowerCase(this.textLocale); }
                    return val;
                });
            }
        }

        /** @type {Promise<BinaryBPlusTreeLeafEntry[]>} */
        let entriesPromise;
        let cache = this.cache(op, val);
        // if (this._cache.has(op) && this._cache.get(op).has(val)) {
        //     // Use cached entries
        //     let entries = this._cache.get(op).get(val);
        //     entriesPromise = Promise.resolve(entries);
        // }
        if (cache) {
            entriesPromise = Promise.resolve(cache);
        }
        else {
            var lock;
            entriesPromise = this._lock(false, `index.query "${op}", ${val}`)
            .then(l => {
                lock = l;
                return this._getTree();
            })
            .then(idx => {
                /**
                 * @type BinaryBPlusTree
                 */
                const tree = idx.tree;
                const searchOptions = {
                    entries: true,
                    // filter: options.filter && options.filter.treeEntries // Don't let tree apply filter, so we can cache results before filtering ourself
                }
                return tree.search(op, val, searchOptions)
                .then(({ entries }) => {
                    lock.release();
                    idx.close();

                    // Cache entries
                    // let opCache = this._cache.get(op);
                    // if (!opCache) {
                    //     opCache = new Map();
                    //     this._cache.set(op, opCache);
                    // }
                    // opCache.set(val, entries);
                    this.cache(op, val, entries);

                    return entries;
                });
            });
        }

        return entriesPromise.then(entries => {
            const results = new IndexQueryResults(); //[];
            results.filterKey = this.key;
            results.values = [];

            if (options.filter) {
                // const binaryCompare = (a, b) => {
                //     if (a.length < b.length) { return -1; }
                //     if (a.length > b.length) { return 1; }
                //     for (let i = 0; i < a.length; i++) {
                //         if (a[i] < b[i]) { return -1; }
                //         if (a[i] > b[i]) { return 1; }
                //     }
                //     return 0;
                // };

                let values = [], valueEntryIndexes = [];
                entries.forEach(entry => {
                    valueEntryIndexes.push(values.length);
                    values = values.concat(entry.values);
                });
                // let filterValues = [];
                // options.filter.treeEntries.forEach(entry => filterValues = filterValues.concat(entry.values));
                let filterValues = options.filter.values;

                // Pre-process recordPointers to speed up matching
                const preProcess = (values, tree = false) => {
                    if (tree && values.rpTree) { return; }

                    let builder = tree ? new BPlusTreeBuilder(true, 100) : null;

                    for (let i = 0; i < values.length; i++) {
                        let val = values[i];
                        let rp = val.rp || '';
                        if (rp === '') {
                            for (let j = 0; j < val.recordPointer.length; j++) { rp += val.recordPointer[j].toString(36); }
                            val.rp = rp;
                        }
                        
                        if (tree && !builder.list.has(rp)) {
                            builder.add(rp, [i]);
                        }
                    }
                    if (tree) {
                        values.rpTree = builder.create();
                    }
                }
                // preProcess(values);
                // preProcess(filterValues);

                // Loop through smallest set
                let smallestSet = filterValues.length < values.length ? filterValues : values;
                let otherSet = smallestSet === filterValues ? values : filterValues;
                
                preProcess(smallestSet, false);
                preProcess(otherSet, true);

                // TODO: offload filtering from event loop to stay responsive
                for (let i = 0; i < smallestSet.length; i++) {
                    let value = smallestSet[i];
                    // Find in other set
                    let match = null;
                    let matchIndex;
                    // // for (let j = 0; j < otherSet.length; j++) {
                    // //     let otherValue = otherSet[j];
                    // //     if (value.rp === otherValue.rp) { //if (binaryCompare(value.recordPointer, otherValue.recordPointer) === 0) {
                    // //         match = smallestSet === values ? value : otherValue;
                    // //         matchIndex = match === value ? i : j;
                    // //         break;
                    // //     }
                    // // }

                    // let j = otherSet.rps.indexOf(smallestSet.rps[i]);
                    // if (j >= 0) {
                    //     match = smallestSet === values ? value : otherSet[j];
                    //     matchIndex = match === value ? i : j;
                    // }
                    
                    /** @type {BPlusTree} */
                    let tree = otherSet.rpTree;
                    let rpEntryValue = tree.find(value.rp);
                    if (rpEntryValue) {
                        let j = rpEntryValue.recordPointer[0];
                        match = smallestSet === values ? value : otherSet[j];
                        matchIndex = match === value ? i : j;                        
                    }

                    if (match) {
                        const recordPointer = _parseRecordPointer(this.path, match.recordPointer);
                        const metadata = match.metadata;
                        const entry = entries[valueEntryIndexes.findIndex((entryIndex, i, arr) => 
                            i + 1 === arr.length || (entryIndex <= matchIndex && arr[i + 1] > matchIndex)
                        )];
                        const result = new IndexQueryResult(recordPointer.key, recordPointer.path, entry.key, metadata);
                        // result.entry = entry;
                        results.push(result);
                        results.values.push(match);
                    }
                }
            }
            else {
                // No filter, add all results
                entries.forEach(entry => {
                    entry.values.forEach(value => {
                        const recordPointer = _parseRecordPointer(this.path, value.recordPointer);
                        const metadata = value.metadata;
                        const result = new IndexQueryResult(recordPointer.key, recordPointer.path, entry.key, metadata);
                        // result.entry = entry;
                        results.push(result);
                        results.values.push(value);
                    });
                });
            }

            // for (let i = 0; i < entries.length; i++) {
            //     const entry = entries[i];
            //     const value = entry.key;
            //     for (let j = 0; j < entry.values.length; j++) {
            //         const entryValue = entry.values[j];
            //         if (options.filter) {
            //             // Filtering should be offloaded from event loop to stay responsive
            //             let filterEntries = options.filter.treeEntries;
            //             let found = false;
            //             for (let k = 0; k < filterEntries.length; k++) {
            //                 let filterEntryValues = filterEntries[k].values;
            //                 for(let l = 0; l < filterEntryValues.length; l++) {
            //                     let filterValue = filterEntryValues[l];
            //                     if (binaryCompare(filterValue.recordPointer, entryValue.recordPointer) === 0) {
            //                         found = true;
            //                         break;
            //                     }
            //                 }
            //                 if (found) { break; }
            //             }
            //             if (!found) {
            //                 continue;
            //             }
            //         }
            //         const recordPointer = _parseRecordPointer(this.path, entryValue.recordPointer);
            //         const metadata = entryValue.metadata;
            //         const result = new IndexQueryResult(recordPointer.key, recordPointer.path, value, metadata);
            //         result.entry = entry;
            //         results.push(result);
            //     }
            // }

            // entries.forEach(entry => {
            //     const value = entry.key;
            //     entry.values.forEach(entryValue => {
            //         if (options.filter) {
            //             let filterEntries = options.filter.treeEntries;
            //             let found = false;
            //             for (let k = 0; k < filterEntries.length; k++) {
            //                 let filterEntryValues = filterEntries[k].values;
            //                 for(let l = 0; l < filterEntryValues.length; l++) {
            //                     let filterValue = filterEntryValues[l];
            //                     if (binaryCompare(filterValue.recordPointer, entryValue.recordPointer) === 0) {
            //                         found = true;
            //                         break;
            //                     }
            //                 }
            //                 if (found) { break; }
            //             }
            //             if (!found) {
            //                 return;
            //             }
            //         }
            //         const recordPointer = _parseRecordPointer(this.path, entryValue.recordPointer);
            //         const metadata = entryValue.metadata;
            //         const result = new IndexQueryResult(recordPointer.key, recordPointer.path, value, metadata);
            //         result.entry = entry;
            //         results.push(result);
            //     });
            // });

            // entries.forEach(entry => {
            //     const value = entry.key;
            //     entry.values.forEach(entryValue => {
            //         const recordPointer = _parseRecordPointer(this.path, entryValue.recordPointer);
            //         if (options.filter && options.filter.findIndex(result => result.path === recordPointer.path) < 0) {
            //             return;
            //         }

            //         const metadata = entryValue.metadata;
            //         const result = new IndexQueryResult(recordPointer.key, recordPointer.path, value, metadata);
            //         result.entry = entry;
            //         results.push(result);
            //     });
            // });
            return results;
        });
    }
    
    /**
     * @param {object} [options]
     * @param {(tree: BPlusTreeBuilder, value: any, recordPointer: number[], metadata?: object, env: { path: string, wildcards: string[], key: string }) => void} [options.addCallback] 
     * @param {number[]} [options.valueTypes]
     */
    build(options) {
        const path = this.path;
        const hasWildcards = path.indexOf('*') >= 0;
        const nrOfWildcards = hasWildcards ? /\*/g.exec(this.path).length : 0;
        const wildcardsPattern = '^' + path.replace(/\*/g, "([a-z0-9\-_$]+)") + '/';
        const wildcardRE = new RegExp(wildcardsPattern, 'i');
        let treeBuilder = new BPlusTreeBuilder(false, FILL_FACTOR, this.includeKeys.concat(this.indexMetadataKeys)); //(30, false);
        let idx; // Once using binary file to write to
        const tid = ID.generate();
        const keys = PathInfo.getPathKeys(path);
        const indexableTypes = [Node.VALUE_TYPES.STRING, Node.VALUE_TYPES.NUMBER, Node.VALUE_TYPES.BOOLEAN, Node.VALUE_TYPES.DATETIME];
        const allowedKeyValueTypes = options && options.valueTypes
            ? options.valueTypes
            : indexableTypes;
        debug.log(`Index build ${this.description} started`.blue);
        let indexedValues = 0;
        let addPromise;
        let flushed = false;

        const __DEV_UNIQUE_SET = new Set();
        const __DEV_CHECK_UNIQUE = (key) => {
            if (__DEV_UNIQUE_SET.has(key)) {
                console.warn(`Duplicate key: ${key}`);
            }
            else {
                __DEV_UNIQUE_SET.add(key);
            }
        };

        const buildFile = this.fileName + '.build';
        const createBuildFile = () => {
            return new Promise((resolve, reject) => {
                const buildWriteStream = fs.createWriteStream(buildFile, { flags: pfs.flags.readAndAppendAndCreate });
                const streamState = { wait: false, chunks: [] };
                buildWriteStream.on('error', (err) => {
                    console.error(err);
                    reject(err);
                });
                buildWriteStream.on('open', () => {
                    return getAll('', 0)
                    .then(() => {
                        console.log(`done writing values`);
                        if (streamState.wait) {
                            buildWriteStream.once('drain', () => {
                                buildWriteStream.end(resolve);
                            });
                        }
                        else {
                            buildWriteStream.end(resolve);
                        }
                    });                    
                });                
                buildWriteStream.on('drain', () => {
                    // Write queued chunks
                    let totalBytes = streamState.chunks.reduce((total, bytes) => total + bytes.length, 0);
                    let buffer = new Uint8Array(totalBytes);
                    let offset = 0;
                    streamState.chunks.forEach(bytes => {
                        buffer.set(bytes, offset);
                        offset += bytes.length;
                    });
                    // Write!
                    streamState.chunks = [];
                    streamState.wait = !buildWriteStream.write(buffer, err => {
                        console.assert(!err, `Failed to write to stream: ${err && err.message}`);
                    });
                });
                const writeToStream = bytes => {
                    if (streamState.wait) {
                        streamState.chunks.push(bytes);
                        console.assert(streamState.chunks.length < 100000, 'Something going wrong here');
                    }
                    else {
                        streamState.wait = !buildWriteStream.write(Buffer.from(bytes), err => {
                            console.assert(!err, `Failed to write to stream: ${err && err.message}`);
                        });
                    }
                }
                const getAll = (currentPath, keyIndex) => {
                    // "users/*/posts" 
                    // --> Get all children of "users", 
                    // --> get their "posts" children,
                    // --> get their children to index

                    let path = currentPath;
                    while (keys[keyIndex] && keys[keyIndex] !== '*') {
                        path = PathInfo.getChildPath(path, keys[keyIndex]); // += keys[keyIndex];
                        keyIndex++;
                    }
                    const isTargetNode = keyIndex === keys.length;
                    
                    const getChildren = () => {
                        let children = [];

                        return Node.getChildren(this.storage, path)
                        .next(child => {
                            let keyOrIndex = typeof child.index === 'number' ? child.index : child.key;
                            if (!child.address || child.type !== Node.VALUE_TYPES.OBJECT) { //if (child.storageType !== "record" || child.valueType !== VALUE_TYPES.OBJECT) {
                                return; // This child cannot be indexed because it is not an object with properties
                            }
                            else {
                                children.push(keyOrIndex);
                            }
                        })
                        .catch(reason => {
                            // Record doesn't exist? No biggy
                            debug.warn(`Could not load record "/${path}": ${reason.message}`);
                        })
                        .then(() => {
                            // Iterate through the children in batches of max n nodes
                            // should be determined by amount of * wildcards - If there are 0, 100 are ok, if there is 1, 10 (sqrt of 100), if there are 2, 3.somethign 
                            // Algebra refresh:
                            // a = Math.pow(b, c)
                            // c = Math.log(a) / Math.log(b)
                            // b = Math.pow(a, Math.pow(0.5, c))
                            // a is our max batch size, we'll use 100
                            // c is our depth (nrOfWildcards) so we know this
                            // b is our unknown start number
                            const maxBatchSize = Math.round(Math.pow(500, Math.pow(0.5, nrOfWildcards))); 
                            let batches = [];
                            while (children.length > 0) {
                                let batchChildren = children.splice(0, maxBatchSize);
                                batches.push(batchChildren);
                            }

                            const nextBatch = () => {
                                const batch = batches.shift();
                                return Promise.all(batch.map(childKey => {
                                    const childPath = PathInfo.getChildPath(path, childKey);
                                    // do it
                                    if (!isTargetNode) {
                                        // Go deeper
                                        return getAll(childPath, keyIndex+1);
                                    }
                                    else {
                                        // We have to index this child, get all required values for the entry
                                        const keyFilter = [this.key].concat(this.includeKeys);
                                        let keyValue = null; // initialize to null so we can check if it had a valid indexable value
                                        const metadata = (() => {
                                            // create properties for each included key, if they are not set by the loop they will still be in the metadata (which is required for B+Tree metadata)
                                            const obj = {};
                                            this.includeKeys.forEach(key => obj[key] = undefined);
                                            return obj;
                                        })();
                                        const addValue = (key, value) => {
                                            // if (typeof value === 'string' && value.length > 255) {
                                            //     value = value.slice(0, 255);
                                            // }
                                            if (typeof value === 'string' && !this.caseSensitive) {
                                                value = value.toLocaleLowerCase(this.textLocale);
                                            }
                                            if (key === this.key) { keyValue = value; }
                                            else { metadata[key] = value; };
                                        };
                                        let valuePromise;
                                        if (this.key === '{key}' && (!this.includedKeys || this.includedKeys.length === 0)) {
                                            // Index this child's key only, no need to fetch their value
                                            keyValue = childKey;
                                            valuePromise = Promise.resolve();
                                        }
                                        else {
                                            // Get child values
                                            const keyPromises = [];
                                            const seenKeys = [];
                                            if (this.key === '{key}') {
                                                keyFilter.splice(0, 1); // Remove from selection
                                                seenKeys.push(this.key);
                                                keyValue = childKey;
                                            }
                                            valuePromise = Node.getChildren(this.storage, childPath, keyFilter)
                                            .next(childInfo => {
                                                // What can be indexed? 
                                                // strings, numbers, booleans, dates, undefined
                                                seenKeys.push(childInfo.key);
                                                if (childInfo.key === this.key && allowedKeyValueTypes.indexOf(childInfo.valueType) < 0) {
                                                    // Key value isn't allowed to be this type, mark it as null so it won't be indexed
                                                    keyValue = null;
                                                    return;
                                                }
                                                else if (childInfo.key !== this.key && indexableTypes.indexOf(childInfo.valueType) < 0) {
                                                    // Metadata that can't be indexed because it has the wrong type
                                                    return;
                                                }
                                                // Index this value
                                                if (childInfo.address) {
                                                    const p = Node.getValue(this.storage, childInfo.address.path, { tid })
                                                        .then(value => {
                                                            addValue(childInfo.key, value);
                                                        });
                                                    keyPromises.push(p);
                                                }
                                                else {
                                                    addValue(childInfo.key, childInfo.value);
                                                }
                                            })
                                            .then(() => {
                                                // If the key value wasn't present, set it to undefined (so it'll be indexed)
                                                if (seenKeys.indexOf(this.key) < 0) { keyValue = undefined; }
                                                return Promise.all(keyPromises);
                                            });
                                        }

                                        return valuePromise.then(() => {
                                            const addIndexValue = (key, recordPointer, metadata) => {

                                                // NEW: write value to buildStream
                                                const bytes = [
                                                    0, 0, 0, 0, // entry_length
                                                    0 // processed
                                                ];

                                                // key:
                                                let keyBytes = BinaryWriter.getBytes(key);
                                                bytes.push(...keyBytes);
                        
                                                // rp_length:
                                                bytes.push(recordPointer.length);

                                                // rp_data:
                                                bytes.push(...recordPointer);

                                                // metadata:
                                                this.includeKeys && this.includeKeys.forEach(key => {
                                                    const metadataValue = metadata[key];
                                                    const valueBytes = BinaryWriter.getBytes(metadataValue); // metadata_value
                                                    bytes.push(...valueBytes);
                                                });

                                                // update entry_length:
                                                BinaryWriter.writeUint32(bytes.length, bytes, 0);

                                                writeToStream(bytes);
                                                indexedValues++;
                                            }

                                            // const addIndexValue = (key, recordPointer, metadata) => {
                                            //     indexedValues++;
                                            //     if (!flushed) {
                                            //         if (indexedValues <= 1000000) { // max 1 million (max 255MB) of values in-memory
                                            //             // Add to tree builder
                                            //             treeBuilder.add(key, recordPointer, metadata);
                                            //         }
                                            //         else {
                                            //             // Switch from tree builder to binary tree writer
                                            //             flushed = true;
                                            //             addPromise = this._writeIndex(treeBuilder)
                                            //             .then(() => {
                                            //                 return this._getTree();
                                            //             })
                                            //             .then(i => {
                                            //                 idx = i;
                                            //                 treeBuilder = null;
                                            //                 return idx.tree.add(key, recordPointer, metadata);
                                            //             });
                                            //         }
                                            //     }
                                            //     else {
                                            //         const proceed = () => {
                                            //             return idx.tree.add(key, recordPointer, metadata)
                                            //             .then(() => {
                                            //                 console.log(`added '${key}'`);
                                            //             })
                                            //             .catch(err => {
                                            //                 return rebuild(err)
                                            //                 .then(() => {
                                            //                     return idx.tree.add(key, recordPointer, metadata);
                                            //                 });
                                            //             });
                                            //         }
                                            //         // Chain to addPromise
                                            //         addPromise = addPromise ? addPromise.then(proceed) : proceed();
                                            //     }
                                            // }
                                            // const rebuild = err => {
                                            //     // Could not update index --> leaf full?
                                            //     debug.log(`Could not update index ${this.description}: ${err.message}`.yellow);

                                            //     // NEW: Rebuild with streams
                                            //     const newIndexFile = this.fileName + '.tmp';
                                            //     return pfs.open(newIndexFile, pfs.flags.write)
                                            //     .then(fd => {
                                            //         const treeStatistics = {};
                                            //         const headerStats = {
                                            //             written: false,
                                            //             length: 0,
                                            //             promise: null
                                            //         };

                                            //         const writer = (data, index) => { 
                                            //             let go = () => {
                                            //                 return pfs.write(fd, data, 0, data.length, headerStats.length + index);
                                            //             };
                                            //             if (!headerStats.written) {
                                            //                 // Write header first, or wait until done
                                            //                 let promise = 
                                            //                     headerStats.promise
                                            //                     || this._writeIndexHeader(fd, treeStatistics)
                                            //                     .then(result => {
                                            //                         headerStats.written = true;
                                            //                         headerStats.length = result.length;
                                            //                         headerStats.updateTreeLength = result.treeLengthCallback;
                                            //                     });
                                            //                 headerStats.promise = promise.then(go); // Chain to original promise
                                            //                 return headerStats.promise;
                                            //             }
                                            //             else {
                                            //                 return go();
                                            //             }
                                            //         }
                                            //         return idx.tree.rebuild(
                                            //             BinaryWriter.forFunction(writer), 
                                            //             { fillFactor: FILL_FACTOR, keepFreeSpace: true, increaseMaxEntries: true, treeStatistics }
                                            //         )
                                            //         .then(() => {
                                            //             idx.close();
                                            //             return headerStats.updateTreeLength(treeStatistics.byteLength);
                                            //         })
                                            //         .then(() => {
                                            //             return pfs.close(fd);
                                            //         })
                                            //         .then(() => {
                                            //             // rename new file, overwriting the old file
                                            //             return pfs.rename(newIndexFile, this.fileName);
                                            //         })
                                            //     })
                                            //     .then(() => {
                                            //         return this._getTree();
                                            //     })
                                            //     .then(i => {
                                            //         idx = i;
                                            //     });
                                            // };

                                            if (typeof keyValue !== 'undefined' && keyValue !== null) {
                                                // Add it to the index, using value as the index key, a record pointer as the value
                                                // Create record pointer
                                                let wildcards = [];
                                                if (hasWildcards) {
                                                    const match = wildcardRE.exec(childPath);
                                                    wildcards = match.slice(1);
                                                }
                                                const recordPointer = _createRecordPointer(wildcards, childKey); //, child.address);
                                                // const entryValue = new BinaryBPlusTree.EntryValue(recordPointer, metadata)
                                                // Add it to the index
                                                if (options && options.addCallback) {
                                                    keyValue = options.addCallback(addIndexValue, keyValue, recordPointer, metadata, { path: childPath, wildcards, key: childKey });
                                                }
                                                else {
                                                    if (typeof keyValue === 'string' && keyValue.length > 255) {
                                                        // Make sure strings are not too large to store
                                                        keyValue = keyValue.slice(0, 255);
                                                    }
                                                    addIndexValue(keyValue, recordPointer, metadata);
                                                }
                                                debug.log(`Indexed "/${childPath}/${this.key}" value: '${keyValue}' (${typeof keyValue})`.cyan);
                                            }
                                            // return addPromise; // Do we really have to wait for this?
                                        });
                                    }
                                }))
                                .then(() => {
                                    if (batches.length > 0) { 
                                        return nextBatch(); 
                                    }
                                })
                            }; // nextBatch

                            if (batches.length === 0) { return; }
                            return nextBatch();
                        });
                    };

                    return getChildren();            
                };              
            });
        };

        const mergeFile = `${buildFile}.merge`;
        const createMergeFile = () => {
            // start by grouping the keys:
            // take the first n keys in the .build file, read through the entire file 
            // to find other occurences of the same key. 
            // Group them and write to .build.n files in batches of 10.000 keys
            return pfs.exists(mergeFile)
            .then(exists => {
                if (exists) { 
                    const err = new Error('File already exists');
                    err.code = 'EEXIST';
                    throw err;
                }
                
                return pfs.open(buildFile, pfs.flags.readAndWrite);
            })
            .then(fd => {
                let writer = new BinaryWriter(null, (data, position) => {
                    let buffer = data instanceof Buffer ? data : Buffer.from(data);
                    return pfs.write(fd, buffer, 0, buffer.byteLength, position);
                })
                let reader = new BinaryReader(fd, 512 * 1024); // Read 512KB chunks
                return reader.init()
                .then(() => ({ fd, writer, reader }));
            })
            .then(({ fd, writer, reader }) => {
                // const maxKeys = 10000; // Work with max 10.000 in-memory keys at a time
                const maxValues = 100000; // Max 100K in-memory values
    
                // // TEMP:
                // // See how well index with small leafs performs in 1 by 1 adds
                // const tempBuildIndex = () => {
                //     let builder = new BPlusTreeBuilder(false, 50, this.includeKeys);
                //     /** @type {BinaryBPlusTree} */
                //     let binaryTree
                //     let closeTree;
                //     let adds = 0;
                //     const proceed = () => {
                //         return readNext()
                //         .then(next => {
                //             if (!next) { return; } // done
    
                //             const rpLength = next.value[0];
                //             const recordPointer = Array.from(next.value.slice(1, rpLength + 1));
                //             const metadataBytes = Array.from(next.value.slice(rpLength + 1));
                //             let mdIndex = 0;
                //             const metadata = {};
                //             this.includeKeys && this.includeKeys.forEach(key => {
                //                 let mdItem = BPlusTree.getKeyFromBinary(metadataBytes, mdIndex);
                //                 mdIndex += mdItem.byteLength;
                //                 metadata[key] = mdItem.key;
                //             });
    
                //             adds++;
                //             if (adds < maxValues) { 
                //                 builder.add(next.key, recordPointer, metadata);
                //                 return proceed();
                //             }
                //             else if (adds === maxValues) {
                //                 console.log(`Builder: switching to binary tree`);
                //                 builder.add(next.key, recordPointer, metadata);
                //                 return this._writeIndex(builder)
                //                 .catch(err => {
                //                     console.error(err);
                //                 })
                //                 .then(() => {
                //                     builder = null;
                //                     return this._getTree();
                //                 })
                //                 .then(idx => {
                //                     binaryTree = idx.tree;
                //                     binaryTree.autoGrow = true;
                //                     closeTree = idx.close;
                //                     return proceed();
                //                 })
                //             }
                //             else {
                //                 console.log(`Adding key "${next.key}"`);
                //                 return binaryTree.add(next.key, recordPointer, metadata)
                //                 .catch(err => {
                //                     // const bytes = [];
                //                     // return binaryTree.rebuild(BinaryWriter.forArray(bytes))
                //                     // .then(() => {
                //                     //     closeTree();
                //                     //     return pfs.writeFile(this.fileName, Buffer.from(bytes));
                //                     // })
                //                     // .then(() => {
                //                     //     bytes = null;
                //                     // })
    
                //                     // // TEMP debugging node entry pointing to wrong leaf:
                //                     // // entry "baptiste" points to sourceIndex:3150161
                //                     // // key:"baptiste"
                //                     // // ltChildIndex:3150161
                //                     // // ltChildOffset:3150013
                //                     // if (next.key === "ball") {
                //                     //     return binaryTree.getFirstLeaf().then(leaf => {
                //                     //         let checkLeaf = (leaf) => {
                //                     //             const firstKey = leaf.entries[0].key;
                //                     //             const lastKey = leaf.entries.slice(-1)[0].key;
                //                     //             console.log(`Checking leaf "${firstKey}" to "${lastKey}"`);
                //                     //             if (firstKey <= next.key && lastKey >= next.key) {
                //                     //                 console.log('Found leaf:', leaf);
                //                     //             }
                //                     //             else if (leaf.getNext) {
                //                     //                 return leaf.getNext().then(checkLeaf);
                //                     //             }
                //                     //             else {
                //                     //                 console.log('Not found!');
                //                     //             }
                //                     //         }
                //                     //         return checkLeaf(leaf);
                //                     //     })
                //                     //     .catch(err => {
                //                     //         console.error(err);
                //                     //     });
                //                     // }
    
                //                     closeTree();
                //                     return this._rebuild()
                //                     .then(() => {
                //                         return this._getTree();
                //                     })
                //                     .then(idx => {
                //                         binaryTree = idx.tree;
                //                         closeTree = idx.close;
                //                         // try again
                //                         binaryTree.autoGrow = true;
                //                         return binaryTree.add(next.key, recordPointer, metadata); // Try again
                //                     });
                //                 })
                //                 // .then(() => {
                //                 //     // Test the entry
                //                 //     return binaryTree.findLeaf(next.key)
                //                 //     .then(leaf => {
                //                 //         return Promise.all([
                //                 //             leaf.getPrevious ? leaf.getPrevious() : null,
                //                 //             leaf.getNext ? leaf.getNext() : null,
                //                 //         ]);
                //                 //     })
                //                 //     .then(surroundingLeafs => {
                //                 //         let prev = surroundingLeafs[0];
                //                 //         let next = surroundingLeafs[1];
                //                 //         return Promise.all([
                //                 //             prev ? binaryTree.find(prev.entries[0].key) : null,
                //                 //             next ? binaryTree.find(next.entries[0].key) : null
                //                 //         ])
                //                 //     })
                //                 //     .catch(err => {
                //                 //         console.error(`OOPS: ${err.message}`);
                //                 //         throw err;
                //                 //     });
                //                 // })
                //                 // .then(() => {
                //                 //     // Test the whole tree
                //                 //     let checked = 0;
                //                 //     const lookupLeafEntries = (leaf) => {
                //                 //         const firstEntry = leaf.entries[0];
                //                 //         const lastEntry = leaf.entries.slice(-1)[0];
                //                 //         // console.log(`Testing leaf "${firstEntry.key}" to "${lastEntry.key}"`);
                //                 //         const lookupEntry = (entry) => {
                //                 //             return binaryTree.find(entry.key);
                //                 //         }
                //                 //         return Promise.all([
                //                 //             lookupEntry(firstEntry),
                //                 //             lookupEntry(lastEntry)
                //                 //         ])
                //                 //         .catch(err => {
                //                 //             console.error(`NOT GOOD: ${err.message}`);
                //                 //             throw err;
                //                 //         })
                //                 //         .then(() => {
                //                 //             checked += 2;
                //                 //             if (leaf.getNext) {
                //                 //                 return leaf.getNext().then(lookupLeafEntries);
                //                 //             }
                //                 //             else {
                //                 //                 return console.log(`Tree testing done, tested ${checked} entries`);
                //                 //             }
                //                 //         });
    
                //                 //         // let i = 0;
                //                 //         // const nextEntry = () => {
                //                 //         //     let entry = leaf.entries[i++];
                //                 //         //     checked++;
                //                 //         //     if (!entry) {
                //                 //         //         if (leaf.getNext) {
                //                 //         //             return leaf.getNext().then(lookupLeafEntries);
                //                 //         //         }
                //                 //         //         else {
                //                 //         //             return console.log(`Tree testing done, tested ${checked} entries`);
                //                 //         //         }
                //                 //         //     }
                //                 //         //     return binaryTree.find(entry.key)
                //                 //         //     .then(nextEntry)
                //                 //         //     .catch(err => {
                //                 //         //         console.error(`NOT GOOD: ${err.message}`);
                //                 //         //         throw err;
                //                 //         //     })
                //                 //         // }
                //                 //         // return nextEntry();
                //                 //     }
                //                 //     const lookupAllEntries = () => {
                //                 //         return binaryTree.getFirstLeaf()
                //                 //         .then(lookupLeafEntries);
                //                 //     }
                //                 //     return lookupAllEntries();
                //                 // })                  
                //                 .then(() => {
                //                     return proceed();
                //                 });
                //             }
                //         })
                //     };
    
                //     return proceed()
                //     .then(() => {
                //         console.log(`Done! Added ${adds} entries to the index`);
                //     });
                // }
    
                const _processedEntries = new Set();
    
                const readNext = () => {
                    // Read next from file
                    const entryIndex = reader.sourceIndex;
                    return reader.getUint32() // entry_length
                    .catch(err => {
                        console.assert(err.code === 'EOF');
                        err.message = 'No more unprocessed entries';
                        throw err;
                    })
                    .then(entryLength => {
                        return reader.get(entryLength - 4);
                    })
                    .then(buffer => {
                        // processed:
                        let processed = buffer[0] === 1 || _processedEntries.has(entryIndex);
                        if (processed) { 
                            // this one has been processed
                            return readNext();
                        }
    
                        // key:
                        let index = 1;
                        let keyValue = BinaryReader.readValue(buffer, index);
                        index += keyValue.byteLength;
    
                        // value: (combine rp_length, rp_data, metadata)
                        const len = buffer.byteLength - index;
                        let val = buffer.slice(index, index + len); // Buffer.from(buffer.buffer, index, len);
                        return {
                            key: keyValue.value,
                            value: val,
                            index: entryIndex,
                            length: buffer.byteLength + 4,
                            flagProcessed() { 
                                buffer[0] = 1;
                                buffer = null;
                                // TODO: refactor back to use file flagging:
                                // _processedEntries.add(this.index);
                                return writer.write([1], this.index + 4); // flag file
                            }
                            // flagProcessed() { 
    
                            //     // __DEV_CHECK_UNIQUE(this.index);
    
                            //     buffer[0] = 1; // make sure the in-memory cache is also flagged
                            //     buffer = null; // release memory if not referenced anywhere else
                            //     return writer.write([1], this.index + 4); // flag file
                            // }
                        }
                    })
                    .catch(err => {
                        if (err.code === 'EOF') { return null; }
                        throw err;
                    });
                }
    
                // return tempBuildIndex();
    
                const flagProcessed = (entry) => {
                    // set entry's processed flag to 1 so it'll be skipped in next batch
                    // return writer.write([1], entry.index + 4);
                    return entry.flagProcessed();
                };
    
                let batchNr = 1;
                let nextBatchStartEntry = null;
                let nextBatch = () => {
                    let map = new Map();
                    let more = false;
                    let processedValues = 0;
                    let nextEntry = () => {
                        return readNext()
                        .then(next => {
                            if (!next) { return; }
    
                            processedValues++;
                            let values = map.get(next.key);
                            if (values) {
                                // const nv = next.value.join(',');
                                // console.assert(values.findIndex(v => v.join(',') === nv) === -1)
                                values.push(next.value);
                                flagProcessed(next);
                            }
                            // else if (map.size < maxKeys) {
                            //     map.set(next.key, [next.value]);
                            //     flagProcessed(next);
                            // }
                            // else {
                            //     // save for next batch
                            //     // IDEA: this could be refactored to start reading next batch in parallel
                            //     if (!more) {
                            //         more = true;
                            //         nextBatchStartEntry = next;
                            //     }
                            // }
                            else if (processedValues < maxValues) {
                                map.set(next.key, [next.value]);
                                flagProcessed(next);
                            }
                            else {
                                more = true;
                                nextBatchStartEntry = next;
                                return; // Stop this batch
                            }
                            return nextEntry();
                        });
                    };
    
                    const getBatchEntries = () => {
                        if (nextBatchStartEntry !== null) {
                            // Skip already processed entries
                            return reader.go(nextBatchStartEntry.index)
                            .then(() => {
                                nextBatchStartEntry = null;
                                return nextEntry();
                            });
                        }
                        else {
                            return nextEntry();
                        }
                    };
    
                    return getBatchEntries()
                    .then(() => {
    
                        // sort the map keys
                        let sortedKeys = quickSort(map.keys(), (a, b) => {
                            if (BPlusTree.typeSafeComparison.isLess(a, b)) { return -1; }
                            if (BPlusTree.typeSafeComparison.isMore(a, b)) { return 1; }
                            return 0;
                        });
    
                        // write batch
                        let batchStream = fs.createWriteStream(`${buildFile}.${batchNr}`, { flags: pfs.flags.appendAndCreate });
                        // TODO: async writing
                        for (let i = 0; i < sortedKeys.length; i++) {
                            const key = sortedKeys[i];
                            const values = map.get(key);
                            
                            let bytes = [
                                0, 0, 0, 0 // entry_length
                            ];
    
                            // key:
                            let b = BinaryWriter.getBytes(key);
                            bytes.push(...b);
    
                            // // values_byte_length:
                            // const valuesByteLengthIndex = bytes.length;
                            // bytes.push(0, 0, 0, 0);
    
                            // values_length:
                            b = BinaryWriter.writeUint32(values.length, [0, 0, 0, 0], 0);
                            bytes.push(...b);
    
                            for (let j = 0; j < values.length; j++) {
                                let value = values[j];
                                // value_length:
                                b = BinaryWriter.writeUint32(value.length, [0, 0, 0, 0], 0);
                                bytes.push(...b);
    
                                // value:
                                bytes.push(...value);
                            }
    
                            // // update values_byte_length:
                            // const valuesByteLength = bytes.length - valuesByteLengthIndex
                            // BinaryWriter.writeUint32(valuesByteLength, bytes, valuesByteLengthIndex);
    
                            // Update entry_length:
                            BinaryWriter.writeUint32(bytes.length, bytes, 0);
    
                            let ok = batchStream.write(Buffer.from(bytes));
                            // TODO: check ok
                        }
                        return new Promise(resolve => {
                            batchStream.end(resolve);
                        })
                        .then(() => {
                            if (more) {
                                // Proceed with next batch
                               batchNr++;
                               return nextBatch();
                           }
                        });
                    });
                };
    
                const createBatches = () => {
                    return nextBatch();
                }
    
                return createBatches()
                .then(() => {
                    // Now merge-sort all keys, by reading keys from each batch, 
                    // taking the smallest value from each batch a time
                    const batches = batchNr;
    
                    // create write stream for merged data
                    const outputStream = fs.createWriteStream(`${mergeFile}`, { flags: pfs.flags.appendAndCreate });
                    
                    // open readers
                    const readers = new Array(batches);
                    const readyPromises = [];
                    const bufferChunkSize = Math.max(10240, Math.round((10 * 1024 * 1024) / readers.length)); // 10MB dedicated memory to divide between readers, with a minimum of 10KB per reader
                    for (let i = 0; i < readers.length; i++) {
                        let reader = new BinaryReader(`${buildFile}.${i+1}`, bufferChunkSize);
                        readers[i] = reader;
                        let p = reader.init();
                        readyPromises.push(p);
                    }
    
                    const entriesPerBatch = new Array(batches);
                    let sortedEntryIndexes = [];
                    const loadEntry = (batchIndex) => {
                        const reader = readers[batchIndex];
    
                        // entry_length:
                        return reader.getUint32()
                        .catch(err => {
                            // EOF
                            console.assert(err.code === 'EOF');
                            err.message = 'No more entries in batch file';
                            throw err;
                        })
                        .then(entryLength => {
                            return reader.get(entryLength - 4);
                        })
                        .then(buffer => {
                            // key:
                            const keyValue = BinaryReader.readValue(buffer, 0);
                            const key = keyValue.value;
                            const values = buffer.slice(keyValue.byteLength); //Buffer.from(buffer.buffer, keyValue.byteLength, buffer.byteLength - keyValue.byteLength);

                            // Check if another batch has entry with the same key
                            const existing = entriesPerBatch.find(entry => entry && entry.key === key);
                            if (existing) {
                                // Append values to existing
                                // First 4 bytes of values contains values_length
                                const currentValues = BinaryReader.readUint32(existing.values, 0);
                                const additionalValues = BinaryReader.readUint32(values, 0);

                                const concatenated = new Buffer(existing.values.byteLength + values.byteLength - 4);
                                concatenated.set(existing.values, 0);
                                concatenated.set(values.slice(4), existing.values.byteLength);

                                // Update values_length to total
                                BinaryWriter.writeUint32(currentValues + additionalValues, concatenated, 0);
                                existing.values = concatenated;
                                return loadEntry(batchIndex);
                            }

                            // Create new entry
                            const entry = { key, values };
                            entriesPerBatch[batchIndex] = entry;
    
                            // update sortedEntryIndexes (only if it has been populated already, not when loading start values)
                            if (sortedEntryIndexes.length > 0) {
                                // remove the old entry
                                const oldSortEntryIndex = sortedEntryIndexes.findIndex(sortEntry => sortEntry.index === batchIndex);
                                sortedEntryIndexes.splice(oldSortEntryIndex, 1);
                                // create new entry, insert at right sorted location
                                // const newSortEntryIndex = sortedEntryIndexes.findIndex(sortEntry => BPlusTree.typeSafeComparison.isMore(sortEntry.key, entry.key));
                                let newSortEntryIndex = oldSortEntryIndex; // The newly read value >= previous value, because they are stored sorted in the batch file
                                while(
                                    newSortEntryIndex < sortedEntryIndexes.length 
                                    && BPlusTree.typeSafeComparison.isMore(entry.key, sortedEntryIndexes[newSortEntryIndex].key)) 
                                {
                                    newSortEntryIndex++;
                                }
                                const newSortEntry = { index: batchIndex, key: entry.key };
                                sortedEntryIndexes.splice(newSortEntryIndex, 0, newSortEntry);
                            }
                            return entry;
                        })
                        .catch(err => {
                            if (err.code === 'EOF') {
                                // set this batch's entry to null
                                entriesPerBatch[batchIndex] = null;
                                // remove from sortedEntryIndexes
                                console.assert(sortedEntryIndexes.length > 0);
                                const sortEntryIndex = sortedEntryIndexes.findIndex(sortEntry => sortEntry.index === batchIndex);
                                sortedEntryIndexes.splice(sortEntryIndex, 1);
                            }
                            else {
                                throw err;
                            }
                        });
                    }
    
                    const loadEntries = () => {
                        let promises = [];
                        for (let i = 0; i < readers.length; i++) {
                            let p = loadEntry(i);
                            promises.push(p);
                        }
    
                        return Promise.all(promises)
                        .then(() => {
                            // Populate sortedEntryIndexes
                            sortedEntryIndexes = entriesPerBatch.map((entry, index) => ({ index, key: entry.key }))
                            .sort((a, b) => {
                                if (BPlusTree.typeSafeComparison.isLess(a.key, b.key)) { return -1; }
                                if (BPlusTree.typeSafeComparison.isMore(a.key, b.key)) { return 1; }
                                return 0; // happens when a key had too many values (and were split into multiple batches)
                            });
                        });
                    }
    
                    const writeSmallestEntry = () => {
                        if (sortedEntryIndexes.length === 0) {
                            // done!
                            return new Promise(resolve => {
                                outputStream.end(resolve);
                            }); 
                        }
                        // take smallest (always at index 0 in sorted array)
                        const smallestDetails = sortedEntryIndexes[0];
                        const batchIndex = smallestDetails.index;
                        const smallestEntry = entriesPerBatch[batchIndex];

                        const bytes = [
                            0, 0, 0, 0 // entry_length
                        ];
                        // key:
                        const keyBytes = BinaryWriter.getBytes(smallestEntry.key);
                        bytes.push(...keyBytes);
    
                        // update entry_length
                        const byteLength = bytes.length + smallestEntry.values.byteLength;
                        BinaryWriter.writeUint32(byteLength, bytes, 0);
    
                        // build buffer
                        const buffer = new Buffer(byteLength);
                        buffer.set(bytes, 0);
                        // values:
                        buffer.set(smallestEntry.values, bytes.length);
    
                        // write to stream
                        const ok = outputStream.write(buffer, err => {
                            console.assert(!err, 'Error while writing. All is lost')
                        });
                        // TODO: handle !ok
                        return loadEntry(batchIndex)
                        .then(writeSmallestEntry);
                    };
    
                    const writeEntries = () => {
                        return writeSmallestEntry();
                    }
    
                    return Promise.all(readyPromises)
                    .then(loadEntries)
                    .then(() => {
                        return writeEntries();
                    })
                    .then(() => {
                        // readers.forEach(reader => reader.close());
                        // write stream has already been closed
                        const promises = readers.map(reader => reader.close());
                        return Promise.all(promises);
                    })
                    .then(() => {
                        // Delete all batch files
                        const promises = [];    
                        for(let i = 1; i <= batches; i++) {
                            promises.push(pfs.rm(`${buildFile}.${i}`));
                        }
                        return Promise.all(promises);
                    });
                });
            })
            .catch(err => {
                // EEXIST error is ok because that means the .merge file was already built
                if (err.code !== 'EEXIST') {
                    throw err;
                }
            });
        };

        const startTime = Date.now();
        let lock;
        return this._lock(true, `index.build ${this.description}`)
        .then(l => {
            lock = l;
            return createBuildFile();
        })
        .catch(err => {
            // If the .build file already existed, use it!
            if (err.code !== 'EEXIST') { throw err; }
        })
        .then(() => {
            // Done writing values to build file. 
            // Now we have to group all values per key, sort them.
            // then create the binary B+tree.
            console.log(`done writing build file`);
            return createMergeFile();
        })
        .then(() => {
            // Open merge file for reading, index file for writing
            console.log(`done writing merge file`);
            return Promise.all([
                pfs.open(mergeFile, pfs.flags.read),
                pfs.open(this.fileName, pfs.flags.write),
                pfs.rm(buildFile)
            ]);
        })
        .then(([ readFD, writeFD ]) => {
            // create index from entry stream
            const treeStatistics = {};
            const headerStats = { 
                written: false, 
                updateTreeLength: () => { 
                    throw new Error(`header hasn't been written yet`); 
                },
                length: DISK_BLOCK_SIZE
            };
            const reader = new BinaryReader(readFD);
            // const writeStream = fs.createWriteStream(this.fileName, { fd: writeFD, autoClose: false, start: headerStats.length });
            // const writer = new BinaryWriter(writeStream, (data, index) => {
            const writer = BinaryWriter.forFunction((data, index) => {
                let go = () => {
                    return pfs.write(writeFD, data, 0, data.length, headerStats.length + index);
                };
                if (!headerStats.written) {
                    // Write header first, or wait until done
                    let promise = 
                        headerStats.promise
                        || this._writeIndexHeader(writeFD, treeStatistics)
                        .then(result => {
                            headerStats.written = true;
                            headerStats.length = result.length;
                            headerStats.updateTreeLength = result.treeLengthCallback;
                        });
                    headerStats.promise = promise.then(go); // Chain to original promise
                    return headerStats.promise;
                }
                else {
                    return go();
                }
            });
            return BinaryBPlusTree.createFromEntryStream(
                reader, 
                writer, 
                { 
                    treeStatistics, 
                    fillFactor: FILL_FACTOR, //50, 
                    maxEntriesPerNode: 255, 
                    isUnique: false, 
                    keepFreeSpace: true, 
                    metadataKeys: this.includeKeys 
                }
            )
            .then(() => {
                return Promise.all([
                    pfs.close(writeFD),
                    pfs.close(readFD)
                ]);
            });
        })
        .then(() => {
            return pfs.rm(mergeFile);
        })
        .then(() => {
            const doneTime = Date.now();
            const duration = Math.round((doneTime - startTime) / 1000 / 60);
            debug.log(`Index ${this.description} was built successfully, took ${duration} minutes`.green);
        })
        .catch(err => {
            debug.error(`Error building index ${this.description}: ${err.message}`, err);
        })
        .then(() => {
            lock.release(); // release index lock
            return this;    
        });
    }

    /**
     * 
     * @param {number} fd
     * @param {{ totalEntries: number, totalValues: number }} treeStatistics
     */
    _writeIndexHeader(fd, treeStatistics) {
        const indexEntries = treeStatistics.totalEntries;
        const indexedValues = treeStatistics.totalValues;

        const addNameBytes = (bytes, name) => {
            // name_length:
            bytes.push(name.length);
            // name_data:
            for(let i = 0; i < name.length; i++) {
                bytes.push(name.charCodeAt(i));
            }
        }
        const addValueBytes = (bytes, value) => {
            let valBytes = [];
            if (typeof value === 'undefined') {
                // value_type:
                bytes.push(0);
                // no value_length or value_data
                return;
            }
            else if (typeof value === 'string') {
                // value_type:
                bytes.push(1);
                valBytes = Array.from(textEncoder.encode(value));
            }
            else if (typeof value === 'number') {
                // value_type:
                bytes.push(2);
                valBytes = numberToBytes(value);
            }
            else if (typeof value === 'boolean') {
                // value_type:
                bytes.push(3);
                // no value_length
                // value_data:
                bytes.push(value ? 1 : 0);
                // done
                return;
            }
            else if (value instanceof Array) {
                // value_type:
                bytes.push(4);
                // value_length:
                if (value.length > 0xffff) {
                    throw new Error(`Array is too large to store. Max length is 0xffff`)
                }
                bytes.push((value.length >> 8) & 0xff);
                bytes.push(value.length & 0xff);
                // value_data:
                value.forEach(val => {
                    addValueBytes(bytes, val);
                });
                // done
                return;
            }
            else {
                throw new Error(`Invalid value type "${typeof value}"`);
            }
            // value_length:
            bytes.push((valBytes.length >> 8) & 0xff);
            bytes.push(valBytes.length & 0xff);
            // value_data:
            bytes.push(...valBytes);
        }
        const addInfoBytes = (bytes, obj) => {
            const keys = Object.keys(obj);
            // info_count:
            bytes.push(keys.length);
            // info, [info, [info...]]
            keys.forEach(key => {
                addNameBytes(bytes, key); // name

                const value = obj[key];
                // if (value instanceof Array) {
                //     bytes.push(1); // is_array
                //     bytes.push(value.length); // values_count
                //     value.forEach(val => {
                //         addValueBytes(bytes, val); // value
                //     });
                // }
                // else {
                //     bytes.push(0); // is_array
                //     addValueBytes(bytes, value); // value
                // }
                addValueBytes(bytes, value);
            });
        };

        const header = [
            // signature:
            65, 67, 69, 66, 65, 83, 69, 73, 68, 88, // 'ACEBASE'
            // layout_version:
            1,
            // header_length:
            0, 0, 0, 0
        ];
        // info:
        const indexInfo = {
            type: this.type,
            version: 1, // TODO: implement this.versionNr
            path: this.path,
            key: this.key,
            include: this.includeKeys,
            cs: this.caseSensitive,
            locale: this.textLocale,
        };
        addInfoBytes(header, indexInfo);

        // const treeNames = Object.keys(this.trees);
        // trees_info:
        header.push(1); // trees_count
        const treeName = 'default';
        const treeDetails = this.trees[treeName];
        
        // tree_info:
        addNameBytes(header, treeName); // tree_name
        
        const treeRefIndex = header.length;
        header.push(0, 0, 0, 0); // file_index
        header.push(0, 0, 0, 0); // byte_length

        treeDetails.entries = indexEntries;
        treeDetails.values = indexedValues;
        const extraTreeInfo = {
            class: treeDetails.class, // 'BPlusTree',
            version: treeDetails.version, // TODO: implement tree.version
            entries: indexEntries,
            values: indexedValues
        };
        addInfoBytes(header, extraTreeInfo);

        // align header bytes to block size
        while (header.length % DISK_BLOCK_SIZE !== 0) {
            header.push(0);
        }

        // end of header

        const headerLength = header.length;
        treeDetails.fileIndex = headerLength;
        // treeDetails.byteLength = binary.length;

        // Update header_length:
        header[11] = (headerLength >> 24) & 0xff;
        header[12] = (headerLength >> 16) & 0xff;
        header[13] = (headerLength >> 8) & 0xff;
        header[14] = headerLength & 0xff;       

        // Update default tree file_index:
        header[treeRefIndex] = (headerLength >> 24) & 0xff;
        header[treeRefIndex+1] = (headerLength >> 16) & 0xff;
        header[treeRefIndex+2] = (headerLength >> 8) & 0xff;
        header[treeRefIndex+3] = headerLength & 0xff;

        // // Update default tree byte_length:
        // header[treeRefIndex+4] = (binary.byteLength >> 24) & 0xff;
        // header[treeRefIndex+5] = (binary.byteLength >> 16) & 0xff;
        // header[treeRefIndex+6] = (binary.byteLength >> 8) & 0xff;
        // header[treeRefIndex+7] = binary.byteLength & 0xff;

        // anything else?

        return pfs.write(fd, Buffer.from(header))
        .then(() => {
            return {
                length: headerLength,
                treeLengthCallback: (treeByteLength) => {
                    const bytes = [
                        (treeByteLength >> 24) & 0xff,
                        (treeByteLength >> 16) & 0xff,
                        (treeByteLength >> 8) & 0xff,
                        treeByteLength & 0xff
                    ];
                    // treeDetails.byteLength = treeByteLength;
                    return pfs.write(fd, Buffer.from(bytes), 0, bytes.length, treeRefIndex+4);
                }
            };
        });
    }

    /**
     * 
     * @param {BPlusTreeBuilder} builder 
     */
    _writeIndex(builder) {
        // Index v1 layout:
        // data             = header, trees_data
        // header           = signature, layout_version, header_length, index_info, trees_info
        // signature        = 10 bytes ('ACEBASEIDX')
        // layout_version   = 1 byte number (binary layout version)            
        // header_length    = byte_length
        // byte_length      = 4 byte uint
        // index_info       = info_count, info, [info, [info...]]
        // info_count       = 1 byte number
        // info             = key, info_value
        // key              = key_length, key_name
        // key_length       = 1 byte number
        // key_name         = [key_length] bytes (ASCII encoded key name)
        // info_value       = value_type, [value_length], [value_data]
        // value_type       = 1 byte number
        //                      0: UNDEFINED
        //                      1: STRING
        //                      2: NUMBER
        //                      3: BOOLEAN
        //                      4: ARRAY
        // value_length     = value_type ?
        //                      0, 3: (not present)
        //                      1, 2, 4: 2 byte number
        // value_data       = value_type ?
        //                      0: (not present)
        //                      1-3: value_length bytes
        //                      4: info_value[value_length]
        // trees_info       = trees_count, tree_info, [tree_info, [tree_info...]]
        // trees_count      = 1 byte number
        // tree_info        = tree_name, file_index, byte_length, xtree_info
        // tree_name        = key
        // file_index       = 4 byte uint
        // xtree_info       = info_count, info, [info, [info...]]
        // trees_data       = tree_data, [tree_data, [tree_date...]]
        // tree_data        = [byte_length] bytes of data (from tree_info header)

        const indexEntries = builder.list.size;
        const indexedValues = builder.indexedValues;
        // const tree = builder.create();
        // const binary = new Uint8Array(tree.toBinary(true));
        
        return pfs.open(this.fileName, pfs.flags.write)
        .then(fd => {
            const addNameBytes = (bytes, name) => {
                // name_length:
                bytes.push(name.length);
                // name_data:
                for(let i = 0; i < name.length; i++) {
                    bytes.push(name.charCodeAt(i));
                }
            }
            const addValueBytes = (bytes, value) => {
                let valBytes = [];
                if (typeof value === 'undefined') {
                    // value_type:
                    bytes.push(0);
                    // no value_length or value_data
                    return;
                }
                else if (typeof value === 'string') {
                    // value_type:
                    bytes.push(1);
                    valBytes = Array.from(textEncoder.encode(value));
                }
                else if (typeof value === 'number') {
                    // value_type:
                    bytes.push(2);
                    valBytes = numberToBytes(value);
                }
                else if (typeof value === 'boolean') {
                    // value_type:
                    bytes.push(3);
                    // no value_length
                    // value_data:
                    bytes.push(value ? 1 : 0);
                    // done
                    return;
                }
                else if (value instanceof Array) {
                    // value_type:
                    bytes.push(4);
                    // value_length:
                    if (value.length > 0xffff) {
                        throw new Error(`Array is too large to store. Max length is 0xffff`)
                    }
                    bytes.push((value.length >> 8) & 0xff);
                    bytes.push(value.length & 0xff);
                    // value_data:
                    value.forEach(val => {
                        addValueBytes(bytes, val);
                    });
                    // done
                    return;
                }
                else {
                    throw new Error(`Invalid value type "${typeof value}"`);
                }
                // value_length:
                bytes.push((valBytes.length >> 8) & 0xff);
                bytes.push(valBytes.length & 0xff);
                // value_data:
                bytes.push(...valBytes);
            }
            const addInfoBytes = (bytes, obj) => {
                const keys = Object.keys(obj);
                // info_count:
                bytes.push(keys.length);
                // info, [info, [info...]]
                keys.forEach(key => {
                    addNameBytes(bytes, key); // name

                    const value = obj[key];
                    // if (value instanceof Array) {
                    //     bytes.push(1); // is_array
                    //     bytes.push(value.length); // values_count
                    //     value.forEach(val => {
                    //         addValueBytes(bytes, val); // value
                    //     });
                    // }
                    // else {
                    //     bytes.push(0); // is_array
                    //     addValueBytes(bytes, value); // value
                    // }
                    addValueBytes(bytes, value);
                });
            };

            const header = [
                // signature:
                65, 67, 69, 66, 65, 83, 69, 73, 68, 88, // 'ACEBASEIDX'
                // layout_version:
                1,
                // header_length:
                0, 0, 0, 0
            ];
            // info:
            const indexInfo = {
                type: this.type,
                version: 1, // TODO: implement this.versionNr
                path: this.path,
                key: this.key,
                include: this.includeKeys,
                cs: this.caseSensitive,
                locale: this.textLocale,
            };
            addInfoBytes(header, indexInfo);

            // const treeNames = Object.keys(this.trees);
            // trees_info:
            header.push(1); // trees_count
            const treeName = 'default';
            const treeDetails = this.trees[treeName];
            
            // tree_info:
            addNameBytes(header, treeName); // tree_name
            
            const treeRefIndex = header.length;
            header.push(0, 0, 0, 0); // file_index
            header.push(0, 0, 0, 0); // byte_length

            treeDetails.entries = indexEntries;
            treeDetails.values = indexedValues;
            const extraTreeInfo = {
                class: treeDetails.class, // 'BPlusTree',
                version: treeDetails.version, // TODO: implement tree.version
                entries: indexEntries,
                values: indexedValues
            };
            addInfoBytes(header, extraTreeInfo);

            // align header bytes to block size
            while (header.length % DISK_BLOCK_SIZE !== 0) {
                header.push(0);
            }

            // end of header

            const headerLength = header.length;
            treeDetails.fileIndex = headerLength;
            // treeDetails.byteLength = binary.length;

            // Update header_length:
            header[11] = (headerLength >> 24) & 0xff;
            header[12] = (headerLength >> 16) & 0xff;
            header[13] = (headerLength >> 8) & 0xff;
            header[14] = headerLength & 0xff;       

            // Update default tree file_index:
            header[treeRefIndex] = (headerLength >> 24) & 0xff;
            header[treeRefIndex+1] = (headerLength >> 16) & 0xff;
            header[treeRefIndex+2] = (headerLength >> 8) & 0xff;
            header[treeRefIndex+3] = headerLength & 0xff;

            // // Update default tree byte_length:
            // header[treeRefIndex+4] = (binary.byteLength >> 24) & 0xff;
            // header[treeRefIndex+5] = (binary.byteLength >> 16) & 0xff;
            // header[treeRefIndex+6] = (binary.byteLength >> 8) & 0xff;
            // header[treeRefIndex+7] = binary.byteLength & 0xff;

            // anything else?

            return pfs.write(fd, Buffer.from(header))
            .then(() => {
                // append binary tree data
                const tree = builder.create();
                const stream = fs.createWriteStream(null, { fd, autoClose: false });
                // const stream = fs.createWriteStream(this.fileName, { start: headerLength });
                const references = [];
                const writer = new BinaryWriter(stream, (data, position) => {
                    references.push({ data, position });
                    return Promise.resolve();
                    // return pfs.write(fd, data, 0, data.byteLength, headerLength + position);
                });
                return tree.toBinary(true, writer)
                .then(() => {
                    // Update all references
                    const nextReference = () => {
                        const ref = references.shift();
                        if (!ref) { return Promise.resolve(); }
                        return pfs.write(fd, ref.data, 0, ref.data.byteLength, headerLength + ref.position)
                        .then(nextReference);
                    }
                    return nextReference();
                })
                .then(() => {                    
                    // Update default tree byte_length:
                    const treeByteLength = writer.length;
                    const bytes = [
                        (treeByteLength >> 24) & 0xff,
                        (treeByteLength >> 16) & 0xff,
                        (treeByteLength >> 8) & 0xff,
                        treeByteLength & 0xff
                    ];
                    treeDetails.byteLength = treeByteLength;
                    return pfs.write(fd, Buffer.from(bytes), 0, bytes.length, treeRefIndex+4);
                });
                // return pfs.write(fd, binary);
            })
            .then(() => {
                return pfs.close(fd);
            })
            .catch(err => {
                debug.error(err);
                throw err;
            })
        });
    }

    _getTree () {
        if (this._idx) {
            this._idx.open++;
            return Promise.resolve(this._idx);
        }
        return ThreadSafe.lock(this.fileName)
        .then(lock => { 
            if (this._idx) {
                this._idx.open++;
                lock.release();
                return Promise.resolve(this._idx);
            }
            return pfs.open(this.fileName, pfs.flags.readAndWrite)
            .then(fd => {
                const reader = (index, length) => {
                    const binary = new Uint8Array(length);
                    const buffer = Buffer.from(binary.buffer);
                    return pfs.read(fd, buffer, 0, length, this.trees.default.fileIndex + index)
                    .then(result => {
                        // Convert Uint8Array to byte array
                        return Array.from(binary);
                    });
                };
                const writer = (data, index) => {
                    const binary = Uint8Array.from(data);
                    const buffer = Buffer.from(binary.buffer);
                    return pfs.write(fd, buffer, 0, data.length, this.trees.default.fileIndex + index)
                    .then(result => {
                        return;
                    });                    
                };
                const tree = new BinaryBPlusTree(reader, DISK_BLOCK_SIZE, writer);
                tree.id = this.fileName; // For tree locking
                const idx = { 
                    open: 1,
                    tree,
                    close: () => {
                        idx.open--;
                        if (idx.open === 0) {
                            this._idx = null;
                            pfs.close(fd)
                            .catch(err => {
                                debug.warn(`Could not close index file "${this.fileName}":`, err);
                            });
                        }
                    }
                };
                this._idx = idx;
                lock.release();
                return idx;
            });
        });
    }
}

class IndexQueryResult {
    /**
     * 
     * @param {string|number} key 
     * @param {string} path 
     * @param {string|number|boolean|Date|undefined} value 
     * @param {object} [metadata] 
     */
    constructor(key, path, value, metadata) {
        this.key = key;
        this.path = path;
        this.value = value;
        this.metadata = metadata;
    }
}

class IndexQueryResults extends Array {
    

    /**
     * @param {IndexQueryResult[]} results 
     */
    static from(results, filterKey) {
        const arr = new IndexQueryResults(results.length);
        results.forEach((result, i) => arr[i] = result);
        arr.filterKey = filterKey;
        return arr;
    }

    set filterKey(key) {
        this._filterKey = key;
    }

    get filterKey() {
        return this._filterKey;
    }

    // /** @param {BinaryBPlusTreeLeafEntry[]} entries */
    // set treeEntries(entries) {
    //     this._treeEntries = entries;
    // }

    // /** @type {BinaryBPlusTreeLeafEntry[]} */
    // get treeEntries() {
    //     return this._treeEntries;
    // }

    /**
     * 
     * @param {(result: IndexQueryResult, index: number, arr: IndexQueryResults) => boolean} callback
     */
    filter(callback) {
        return super.filter(callback);
    }

    filterMetadata(key, op, compare) {
        if (typeof compare === 'undefined') {
            compare = null; // compare with null so <, <=, > etc will get the right results
        }
        if (op === 'exists' || op === '!exists') {
            op = op === 'exists' ? "!=" : "==";
            compare = null;
        }
        const filtered = this.filter(result => {
            let value = result.metadata[key];
            if (typeof value === 'undefined') { 
                value = null; // compare with null
            }
            if (op === '<') { return value < compare; }
            if (op === '<=') { return value <= compare; }
            if (op === '>') { return value > compare; }
            if (op === '>=') { return value >= compare; }
            if (op === '==') { return value == compare; }
            if (op === '!=') { return value != compare; }
            if (op === 'like' || op === '!like') {
                const pattern = '^' + compare.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
                const re = new RegExp(pattern, 'i');
                const isLike = re.test(value);
                return op === 'like' ? isLike : !isLike;
            }
            if (op === 'in' || op === '!in') {
                const isIn = compare instanceof Array && compare.indexOf(value);
                return op === 'in' ? isIn : !isIn;
            }
            if (op == 'between' || op === '!between') {
                let bottom = compare[0], top = compare[1];
                if (top < bottom) {
                    let swap = top;
                    top = bottom;
                    bottom = swap;
                }
                const isBetween = value >= bottom && value <= top;
                return op === 'between' ? isBetween : !isBetween;
            }
            if (op === 'matches' || op === '!matches') {
                const re = compare;
                const isMatch = re.test(value);
                return op === 'matches' ? isMatch : !isMatch;
            }
        });
        return IndexQueryResults.from(filtered, this.filterKey);
    }
}

/**
 * An array index allows all values in an array node to be indexed and searched
 */
class ArrayIndex extends DataIndex {
    constructor(storage, path, key, options) {
        if (key === '{key}') { throw new Error('Cannot create array index on node keys'); }
        super(storage, path, key, options);
    }

    // get fileName() {
    //     return super.fileName.slice(0, -4) + '.array.idx';
    // }

    get type() {
        return 'array';
    }

    /**
     * 
     * @param {string} path 
     * @param {any} oldValue 
     * @param {any} newValue 
     */
    handleRecordUpdate(path, oldValue, newValue) {
        let oldEntries = oldValue[this.key];
        let newEntries = newValue[this.key];
        
        if (!(oldEntries instanceof Array)) { oldEntries = []; }
        if (!(newEntries instanceof Array)) { newEntries = []; }

        let removed = oldEntries.filter(entry => newEntries.indexOf(entry) < 0);
        let added = newEntries.filter(entry => oldEntries.indexOf(entry) < 0);

        const mutated = { old: {}, new: {} };
        Object.assign(mutated.old, oldValue);
        Object.assign(mutated.new, newValue);

        removed.forEach(entry => {
            mutated.old[this.key] = entry;
            mutated.new[this.key] = null;
            super.handleRecordUpdate(path, mutated.old, mutated.new);
        });
        added.forEach(entry => {
            mutated.old[this.key] = null;
            mutated.new[this.key] = entry;
            super.handleRecordUpdate(path, mutated.old, mutated.new);
        });
    }

    build() {
        const addCallback = (add, array, recordPointer, metadata) => {
            if (!(array instanceof Array)) { return []; }
            // if (array.length === 0) {
            //     debug.warn(`No entries found to index array`);
            // }
            array.forEach(entry => {
                add(entry, recordPointer, metadata);
            });
            return array;
        }
        return super.build({ addCallback, valueTypes: [Node.VALUE_TYPES.ARRAY] });
    }

    static get validOperators() {
        return ['contains', '!contains'];
    }
    get validOperators() {
        return ArrayIndex.validOperators;
    }

    query(op, val) {
        if (ArrayIndex.validOperators.indexOf(op) < 0) { //if (op !== 'contains' && op !== '!contains') {
            throw new Error(`Array indexes can only be queried with operator "contains" and "!contains`)
        }
        let searchOp;
        if (op === 'contains') {
            searchOp = '==';
        }
        else if (op === '!contains') {
            searchOp = '!=';
        }
        return super.query(searchOp, val)
    }
}


// const _wordsRegex = /[\w%$#@]+/gu; // OR, with word-regex:   /[a-zA-Z0-9_'\u0392-\u03c9\u0400-\u04FF\u0027]+|[\u4E00-\u9FFF\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af\u0400-\u04FF]+|[\u00E4\u00C4\u00E5\u00C5\u00F6\u00D6]+|[\u0531-\u0556\u0561-\u0586\u0559\u055A\u055B]+|\w+/g;
// const _wordsWithWildcardsRegex = /[\w%$#@?*]+/gu;
// function _getWords(text, wildcards) {
//     if (typeof text !== 'string') {
//         return [];
//     }
//     let words = text.toLowerCase().match(wildcards === true ? _wordsWithWildcardsRegex : _wordsRegex);
//     return words || [];
// }

class WordInfo {
    /**
     * 
     * @param {string} word 
     * @param {number[]} indexes 
     * @param {number[]} sourceIndexes
     */
    constructor(word, indexes, sourceIndexes) {
        this.word = word;
        this.indexes = indexes;
        this.sourceIndexes = sourceIndexes;
    }
    get occurs() {
        return this.indexes.length;
    }
}

const _wordsRegex = /[\w']+/gm; // TODO: should use a better pattern that supports non-latin characters
class TextInfo {
    /**
     * 
     * @param {string} text 
     * @param {string} [locale="en"] 
     */
    constructor(text, locale) {
        this.text = text; // Be gone later...
        this.locale = locale;
        /** @type {WordInfo[]} */
        this.words = [];
        if (text === null) { return; }

        /** @type {Map<string, WordInfo>} */
        let words = new Map();

        // Process the text
        // const wordsRegex = /[\w']+/gu;
        let wordIndex = 0;
        while(true) {
            const match = _wordsRegex.exec(text);
            if (match === null) { break; }
            let word = match[0];

            // TODO: use stemming such as snowball (https://www.npmjs.com/package/snowball-stemmers)
            word = word.toLocaleLowerCase(locale);

            let wordInfo = words.get(word);
            if (wordInfo) {
                wordInfo.indexes.push(wordIndex);
                wordInfo.sourceIndexes.push(match.index);
            }
            else {
                wordInfo = new WordInfo(word, [wordIndex], [match.index]);
                words.set(word, wordInfo);
            }
            wordIndex++;
        }

        words.forEach(word => this.words.push(word));

        this.getWordInfo = (word) => {
            return words.get(word);
        };
    }

    get uniqueWordCount() {
        return this.words.length;
    }
    get wordCount() {
        return this.words.reduce((total, word) => total + word.occurs, 0);
    }
}

/**
 * A full text index allows all words in text nodes to be indexed and searched.
 * Eg: "Every word in this text must be indexed." will be indexed with every word 
 * and can be queried with filters 'contains' and '!contains' a word, words or pattern.
 * Eg: 'contains "text"', 'contains "text indexed"', 'contains "text in*"' will all match the text above.
 * This does not use a thesauris or word lists (yet), so 'contains "query"' will not match.
 * Each word will be stored and searched in lowercase
 */
class FullTextIndex extends DataIndex {
    constructor(storage, path, key, options) {
        if (key === '{key}') { throw new Error('Cannot create fulltext index on node keys'); }
        super(storage, path, key, options);
        // this.enableReverseLookup = true;
        this.indexMetadataKeys = ['_occurs_']; //,'_indexes_'
    }

    // get fileName() {
    //     return super.fileName.slice(0, -4) + '.fulltext.idx';
    // }

    get type() {
        return 'fulltext';
    }

    /**
     * 
     * @param {string} path 
     * @param {any} oldValue 
     * @param {any} newValue 
     */
    handleRecordUpdate(path, oldValue, newValue) {
        let oldText = oldValue === null ? null : oldValue[this.key],
            newText = newValue === null ? null : newValue[this.key];
        if (typeof oldText === 'object' && oldText instanceof Array) {
            oldText = oldText.join(' ');
        }
        if (typeof newText === 'object' && newText instanceof Array) {
            newText = newText.join(' ');
        }

        const oldTextInfo = new TextInfo(oldText);
        const newTextInfo = new TextInfo(newText);

        // super._updateReverseLookupKey(
        //     path, 
        //     oldText ? textEncoder.encode(oldText) : null, 
        //     newText ? textEncoder.encode(newText) : null, 
        //     metadata
        // );

        const oldWords = oldTextInfo.words.map(w => w.word); // _getWords(oldText);
        const newWords = newTextInfo.words.map(w => w.word); // _getWords(newText);
        
        let removed = oldWords.filter(word => newWords.indexOf(word) < 0);
        let added = newWords.filter(word => oldWords.indexOf(word) < 0);
        let changed = oldWords.filter(word => newWords.indexOf(word) >= 0).filter(word => {
            const oldInfo = oldTextInfo.getWordInfo(word);
            const newInfo = newTextInfo.getWordInfo(word);
            return oldInfo.occurs !== newInfo.occurs || oldInfo.indexes.some((index, i) => newInfo.indexes[i] !== index);
        })
        changed.forEach(word => {
            // Word metadata changed. Simplest solution: remove and add again
            removed.push(word);
            added.push(word);
        })
        removed.forEach(word => {
            super.handleRecordUpdate(path, { [this.key]: word }, { [this.key]: null });
        });
        added.forEach(word => {
            const mutated = { };
            Object.assign(mutated, newValue);
            mutated[this.key] = word;

            const wordInfo = newTextInfo.getWordInfo(word);
            // const indexMetadata = {
            //     '_occurs_': wordInfo.occurs,
            //     '_indexes_': wordInfo.indexes.join(',')
            // };
            const indexMetadata = {
                '_occurs_': wordInfo.indexes.join(',')
            };
            super.handleRecordUpdate(path, { [this.key]: null }, mutated, indexMetadata);
        });
    }

    build() {
        const addCallback = (add, text, recordPointer, metadata, env) => {
            if (typeof text === 'object' && text instanceof Array) {
                text = text.join(' ');
            }
            const textInfo = new TextInfo(text, this.textLocale);
            const words = textInfo.words; //_getWords(text);
            if (words.length === 0) {
                debug.warn(`No words found to fulltext index "${env.path}"`);
            }
            
            // const revLookupKey = super._getRevLookupKey(env.path);
            // tree.add(revLookupKey, textEncoder.encode(text), metadata);

            words.forEach(wordInfo => {
                
                // IDEA: To enable fast '*word' queries (starting with wildcard), we can also store 
                // reversed words and run reversed query 'drow*' on it. we'd have to enable storing 
                // multiple B+Trees in a single index file: a 'forward' tree & a 'reversed' tree

                // IDEA: Following up on previous idea: being able to backtrack nodes within an index would
                // help to speed up sorting queries on an indexed key, 
                // eg: query .take(10).filter('rating','>=', 8).sort('title')
                // does not filter on key 'title', but can then use an index on 'title' for the sorting:
                // it can take the results from the 'rating' index and backtrack the nodes' titles to quickly
                // get a sorted top 10. We'd have to store a seperate 'backtrack' tree that uses recordPointers
                // as the key, and 'title' values as recordPointers. Caveat: max string length for sorting would 
                // then be 255 ASCII chars, because that's the recordPointer size limit.
                // The same boost can currently only be achieved by creating an index that includes 'title' in 
                // the index on 'rating' ==> db.indexes.create('movies', 'rating', { include: ['title'] })

                // Extend metadata with more details about the word (occurrences, positions)
                // const wordMetadata = {
                //     '_occurs_': wordInfo.occurs,
                //     '_indexes_': wordInfo.indexes.join(',')
                // };
                const wordMetadata = {
                    '_occurs_': wordInfo.indexes.join(',')
                };
                Object.assign(wordMetadata, metadata);
                add(wordInfo.word, recordPointer, wordMetadata);
            });
            return words.map(info => info.word);
        }
        return super.build({ addCallback, valueTypes: [Node.VALUE_TYPES.STRING] });
    }

    static get validOperators() {
        return ['fulltext:contains', 'fulltext:!contains'];
    }
    get validOperators() {
        return FullTextIndex.validOperators;
    }

    query(op, val, options = {}) {        
        if (FullTextIndex.validOperators.indexOf(op) < 0) { //if (op !== 'fulltext:contains' && op !== 'fulltext:not_contains') {
            throw new Error(`Fulltext indexes can only be queried with operator "fulltext:contains" and "fulltext:!contains`)
        }

        // Check cache. Using the _cache Map does not clash with the superclass's cache because the op will be different
        // if (this._cache.has(op) && this._cache.get(op).has(val)) {
        //     // Use cached results
        //     let results = this._cache.get(op).get(val);
        //     return Promise.resolve(results);
        // }
        let cache = this.cache(op, val);
        if (cache) {
            // Use cached results
            return Promise.resolve(cache);
        }

        const searchWordRegex = /[\w'?*]+/g;
        if (~val.indexOf(' OR ')) {
            // Multiple searches in one query: 'secret OR confidential OR "don't tell"'
            // TODO: chain queries instead of running simultanious?
            const queries = val.split(' OR ');
            const promises = queries.map(q => this.query(op, q));
            return Promise.all(promises)
            .then(resultSets => {
                const merged = resultSets[0];
                resultSets.slice(1).forEach(results => {
                    results.forEach(result => {
                        const exists = ~merged.findIndex(r => r.path === result.path);
                        if (!exists) { merged.push(result); }
                    });
                });
                return IndexQueryResults.from(merged, this.key);
            });
        }
        if (~val.indexOf('"')) {
            // Phrase(s) used. We have to make sure the words used are not only in the text,
            // but also in that exact order.
            const phraseRegex = /"(.+?)"/g;
            const phrases = [];
            while (true) {
                const match = phraseRegex.exec(val);
                if (match === null) { break; }
                const phrase = match[1];
                phrases.push(phrase);
                val = val.slice(0, match.index) + val.slice(match.index + match[0].length);
                phraseRegex.lastIndex = 0;
            }

            const promises = phrases.map(phrase => this.query(op, phrase, { phrase: true }));

            // Check if what is left over still contains words
            if (val.match(searchWordRegex) !== null) {
                // Add it
                const promise = this.query(op, val);
                promises.push(promise);
            }

            return Promise.all(promises)
            .then(resultSets => {
                // Take shortest set, only keep results that are matched in all other sets
                const shortestSet = resultSets.sort((a,b) => a.length < b.length ? -1 : 1)[0];
                const otherSets = resultSets.slice(1);
                const matches = shortestSet.reduce((matches, match) => {
                    // Check if the key is present in the other result sets
                    const path = match.path;
                    const matchedInAllSets = otherSets.every(set => set.findIndex(match => match.path === path) >= 0);
                    if (matchedInAllSets) { matches.push(match); }
                    return matches;
                }, new IndexQueryResults());
                matches.filterKey = this.key;
                return matches;
            });
        }
        let words = val.match(searchWordRegex); //_getWords(val, true);
        if (words === null) {
            // Resolve with empty array
            return Promise.resolve(IndexQueryResults.from([], this.key));
        }
        else {
            // Remove any double words
            words = words.reduce((words, word) => {
                if (words.indexOf(word)<0) { words.push(word); }
                return words;
            }, []);
        }

        // Get result count for each word
        const countPromises = words.map(word => {
            const wildcardIndex = ~(~word.indexOf('*') || ~word.indexOf('?'));
            let wordOp;
            if (op === 'fulltext:contains') {
                wordOp = wildcardIndex >= 0 ? 'like' : '==';
            }
            else if (op === 'fulltext:!contains') {
                wordOp = wildcardIndex >= 0 ? '!like' : '!=';
            }
            // return super.query(wordOp, word)
            return super.count(wordOp, word)
            .then(count => {
                return { word, count};
            });            
        });
        return Promise.all(countPromises).then(counts => {
            // Start with the smallest result set
            counts.sort((a, b) => {
                if (a.count < b.count) { return -1; }
                else if (a.count > b.count) { return 1; }
                return 0;
            });
            const allWords = counts.map(c => c.word);

            // Sequentual method: query 1 word, then filter results further and further
            // More or less performs the same as parallel, but uses less memory
            // NEW: Start with the smallest result set

            // OLD: Use the longest word to search with, then filter those results
            // const allWords = words.slice().sort((a,b) => {
            //     if (a.length < b.length) { return 1; }
            //     else if (a.length > b.length) { return -1; }
            //     return 0;
            // });

            const queryWord = (word, filter) => {
                const wildcardIndex = ~(~word.indexOf('*') || ~word.indexOf('?'));
                let wordOp;
                if (op === 'fulltext:contains') {
                    wordOp = wildcardIndex >= 0 ? 'like' : '==';
                }
                else if (op === 'fulltext:!contains') {
                    wordOp = wildcardIndex >= 0 ? '!like' : '!=';
                }
                // return super.query(wordOp, word)
                return super.query(wordOp, word, { filter });
            }
            let wordIndex = 0;
            let results;
            let resultsPerWord = new Array(words.length);
            const nextWord = () => {
                const word = allWords[wordIndex];
                const t1 = Date.now();
                return queryWord(word, results)
                .then(fr => {
                    const t2 = Date.now();
                    debug.log(`fulltext search for "${word}" took ${t2-t1}ms`);
                    resultsPerWord[words.indexOf(word)] = fr;
                    results = fr;
                    wordIndex++;
                    if (results.length === 0 || wordIndex === allWords.length) { return; }
                    return nextWord();
                });
            }
            return nextWord().then(() => {
                if (options.phrase === true && allWords.length > 1) {
                    // Check which results have the words in the right order
                    results = results.reduce((matches, match) => {
                        // the order of the resultsPerWord is in the same order as the given words,
                        // check if their metadata._occurs_ say the same about the indexed content
                        const path = match.path;
                        const wordMatches = resultsPerWord.map(results => {
                            return results.find(result => result.path === path);
                        });
                        // Convert the _occurs_ strings to arrays we can use
                        wordMatches.forEach(match => {
                            match.metadata._occurs_ = match.metadata._occurs_.split(',').map(parseInt);
                        });
                        const check = (wordMatchIndex, prevWordIndex) => {
                            const sourceIndexes = wordMatches[wordMatchIndex].metadata._occurs_;
                            if (typeof prevWordIndex !== 'number') {
                                // try with each sourceIndex of the first word
                                for (let i = 0; i < sourceIndexes.length; i++) {
                                    const found = check(1, sourceIndexes[i]);
                                    if (found) { return true; }
                                }
                                return false;
                            }
                            // We're in a recursive call on the 2nd+ word
                            if (~sourceIndexes.indexOf(prevWordIndex + 1)) {
                                // This word came after the previous word, hooray!
                                // Proceed with next word, or report success if this was the last word to check
                                if (wordMatchIndex === wordMatches.length-1) { return true; }
                                return check(wordMatchIndex+1, prevWordIndex+1);
                            }
                            else {
                                return false;
                            }
                        }
                        if (check(0)) {
                            matches.push(match); // Keep!
                        }
                        return matches;
                    }, new IndexQueryResults());
                }
                results.filterKey = this.key;
                
                // Cache results
                delete results.values; // No need to cache these. Free the memory
                // let opCache = this._cache.get(op);
                // if (!opCache) {
                //     opCache = new Map();
                //     this._cache.set(op, opCache);
                // }
                // opCache.set(val, results);
                this.cache(op, val, results);
                return results;
            });
        });

        // Parallel method: query all words at the same time, then combine results
        // Uses more memory
        // const promises = words.map(word => {
        //     const wildcardIndex = ~(~word.indexOf('*') || ~word.indexOf('?'));
        //     let wordOp;
        //     if (op === 'fulltext:contains') {
        //         wordOp = wildcardIndex >= 0 ? 'like' : '==';
        //     }
        //     else if (op === 'fulltext:!contains') {
        //         wordOp = wildcardIndex >= 0 ? '!like' : '!=';
        //     }
        //     // return super.query(wordOp, word)
        //     return super.query(wordOp, word)
        // });
        // return Promise.all(promises)
        // .then(resultSets => {
        //     // Now only use matches that exist in all result sets
        //     const sortedSets = resultSets.slice().sort((a,b) => a.length < b.length ? -1 : 1)
        //     const shortestSet = sortedSets[0];
        //     const otherSets = sortedSets.slice(1);
        //     let matches = shortestSet.reduce((matches, match) => {
        //         // Check if the key is present in the other result sets
        //         const path = match.path;
        //         const matchedInAllSets = otherSets.every(set => set.findIndex(match => match.path === path) >= 0);
        //         if (matchedInAllSets) { matches.push(match); }
        //         return matches;
        //     }, new IndexQueryResults());

        //     if (options.phrase === true && resultSets.length > 1) {
        //         // Check if the words are in the right order
        //         console.log(`Breakpoint time`);
        //         matches = matches.reduce((matches, match) => {
        //             // the order of the resultSets is in the same order as the given words,
        //             // check if their metadata._indexes_ say the same about the indexed content
        //             const path = match.path;
        //             const wordMatches = resultSets.map(set => {
        //                 return set.find(match => match.path === path);
        //             });
        //             // Convert the _indexes_ strings to arrays we can use
        //             wordMatches.forEach(match => {
        //                 // match.metadata._indexes_ = match.metadata._indexes_.split(',').map(parseInt);
        //                 match.metadata._occurs_ = match.metadata._occurs_.split(',').map(parseInt);
        //             });
        //             const check = (wordMatchIndex, prevWordIndex) => {
        //                 const sourceIndexes = wordMatches[wordMatchIndex].metadata._occurs_; //wordMatches[wordMatchIndex].metadata._indexes_;
        //                 if (typeof prevWordIndex !== 'number') {
        //                     // try with each sourceIndex of the first word
        //                     for (let i = 0; i < sourceIndexes.length; i++) {
        //                         const found = check(1, sourceIndexes[i]);
        //                         if (found) { return true; }
        //                     }
        //                     return false;
        //                 }
        //                 // We're in a recursive call on the 2nd+ word
        //                 if (~sourceIndexes.indexOf(prevWordIndex + 1)) {
        //                     // This word came after the previous word, hooray!
        //                     // Proceed with next word, or report success if this was the last word to check
        //                     if (wordMatchIndex === wordMatches.length-1) { return true; }
        //                     return check(wordMatchIndex+1, prevWordIndex+1);
        //                 }
        //                 else {
        //                     return false;
        //                 }
        //             }
        //             if (check(0)) {
        //                 matches.push(match); // Keep!
        //             }
        //             return matches;
        //         }, new IndexQueryResults());
        //     }
        //     matches.filterKey = this.key;
        //     return matches;
        // });
    }
}

function _getGeoRadiusPrecision(radiusM) {
    if (typeof radiusM !== 'number') { return; }
    if (radiusM < 0.01) { return 12; }
    if (radiusM < 0.075) { return 11; }
    if (radiusM < 0.6) { return 10; }
    if (radiusM < 2.3) { return 9; }
    if (radiusM < 19) { return 8; }
    if (radiusM < 76) { return 7; }
    if (radiusM < 610) { return 6; }
    if (radiusM < 2400) { return 5; }
    if (radiusM < 19500) { return 4; }
    if (radiusM < 78700) { return 3; }
    if (radiusM < 626000) { return 2; }
    return 1;
}

function _getGeoHash(obj) {
    if (typeof obj.lat !== 'number' || typeof obj.long !== 'number') {
        return;
    }
    const precision = 10; //_getGeoRadiusPrecision(obj.radius);
    const geohash = Geohash.encode(obj.lat, obj.long, precision);
    return geohash;
}

// Berekent welke hashes (van verschillende precisies) er in een straal liggen vanaf middelpunt
function _hashesInRadius(lat, lon, radiusM, precision) {

    const isInCircle = (checkLat, checkLon, lat, lon, radiusM) => {
        let deltaLon = checkLon - lon;
        let deltaLat = checkLat - lat;
        return Math.pow(deltaLon, 2) + Math.pow(deltaLat, 2) <= Math.pow(radiusM, 2);
    };
    const getCentroid = (latitude, longitude, height, width) => {
        let y_cen = latitude + (height / 2);
        let x_cen = longitude + (width / 2);
        return { x: x_cen, y: y_cen };
    }
    const convertToLatLon = (y, x, lat, lon) => {
        let pi = 3.14159265359;
        let r_earth = 6371000;
    
        let lat_diff = (y / r_earth) * (180 / pi);
        let lon_diff = (x / r_earth) * (180 / pi) / Math.cos(lat * pi/180)
    
        let final_lat = lat + lat_diff;
        let final_lon = lon + lon_diff;
    
        return { lat: final_lat, lon: final_lon };
    };

    let x = 0;
    let y = 0;

    let points = [];
    let geohashes = [];

    const gridWidths = [5009400.0, 1252300.0, 156500.0, 39100.0, 4900.0, 1200.0, 152.9, 38.2, 4.8, 1.2, 0.149, 0.0370];
    const gridHeights = [4992600.0, 624100.0, 156000.0, 19500.0, 4900.0, 609.4, 152.4, 19.0, 4.8, 0.595, 0.149, 0.0199];

    let height = gridHeights[precision-1] / 2;
    let width = gridWidths[precision-1] / 2;

    let latMoves = Math.ceil(radiusM / height);
    let lonMoves = Math.ceil(radiusM / width);

    for (let i = 0; i <= latMoves; i++) {
        let tmpLat = y + height*i;

        for (let j = 0; j < lonMoves; j++) {
            let tmpLon = x + width * j;

            if (isInCircle(tmpLat, tmpLon, y, x, radiusM)) {
                let center = getCentroid(tmpLat, tmpLon, height, width);
                points.push(convertToLatLon(center.y, center.x, lat, lon));
                points.push(convertToLatLon(-center.y, center.x, lat, lon));
                points.push(convertToLatLon(center.y, -center.x, lat, lon));
                points.push(convertToLatLon(-center.y, -center.x, lat, lon));
            }
        }
    }

    points.forEach(point => {
        let hash = Geohash.encode(point.lat, point.lon, precision);
        if (geohashes.indexOf(hash) < 0) {
            geohashes.push(hash);
        }
    });

    // Original optionally uses Georaptor compression of geohashes
    // This is my simple implementation
    geohashes.reduce((prev, currentHash, index, arr) => {
        let precision = currentHash.length;
        let parentHash = currentHash.substr(0, precision-1);
        let hashNeighbourMatches = 0;
        let removeIndexes = [];
        arr.forEach((otherHash, otherIndex) => {
            if (otherHash.startsWith(parentHash)) {
                removeIndexes.push(otherIndex);
                if (otherHash.length == precision) {
                    hashNeighbourMatches++;
                }
            }
        });
        if (hashNeighbourMatches === 32) {
            // All 32 areas of a less precise geohash are included.
            // Replace those with the less precise parent
            for (let i = removeIndexes.length - 1; i >= 0; i--) {
                arr.splice(i, 1);
            }
            arr.splice(index, 0, parentHash);
        }
    });

    return geohashes;
}

class GeoIndex extends DataIndex {
    constructor(storage, path, key, options) {
        if (key === '{key}') { throw new Error('Cannot create geo index on node keys'); }
        super(storage, path, key, options);
    }

    // get fileName() {
    //     return super.fileName.slice(0, -4) + '.geo.idx';
    // }

    get type() {
        return 'geo';
    }

    /**
     * 
     * @param {string} path 
     * @param {any} oldValue 
     * @param {any} newValue 
     */
    handleRecordUpdate(path, oldValue, newValue) {
        const mutated = { old: {}, new: {} };
        Object.assign(mutated.old, oldValue);
        Object.assign(mutated.new, newValue);
        if (mutated.old[this.key] !== null && typeof mutated.old[this.key] === 'object') { 
            mutated.old[this.key] = _getGeoHash(mutated.old[this.key]); 
        }
        if (mutated.new[this.key] !== null && typeof mutated.new[this.key] === 'object') { 
            mutated.new[this.key] = _getGeoHash(mutated.new[this.key]); 
        }
        super.handleRecordUpdate(path, mutated.old, mutated.new);
    }

    build() {
        const addCallback = (add, obj, recordPointer, metadata) => {
            if (typeof obj.lat !== 'number' || typeof obj.long !== 'number') {
                debug.warn(`Cannot index location because lat (${obj.lat}) or long (${obj.long}) are invalid`)
                return;
            }
            const geohash = _getGeoHash(obj);
            add(geohash, recordPointer, metadata);
            return geohash;
        }
        return super.build({ addCallback, valueTypes: [Node.VALUE_TYPES.OBJECT] });
    }

    static get validOperators() {
        return ['geo:nearby'];
    }
    
    get validOperators() {
        return GeoIndex.validOperators;
    }

    query(op, val) {
        if (GeoIndex.validOperators.indexOf(op) < 0) {
            throw new Error(`Geo indexes can not be queried with operator "${op}"`)
        }
        if (op === 'geo:nearby') {
            if (typeof val.lat !== 'number' || typeof val.long !== 'number' || typeof val.radius !== 'number') {
                throw new Error(`geo:nearby query must supply an object with properties .lat, .long and .radius`);
            }
            const precision = _getGeoRadiusPrecision(val.radius / 10);
            const targetHashes = _hashesInRadius(val.lat, val.long, val.radius, precision);
            const promises = targetHashes.map(hash => {
                return super.query('like', `${hash}*`);
            });
            return Promise.all(promises)
            .then(resultSets => {
                // Combine all results
                const results = new IndexQueryResults();
                results.filterKey = this.key;
                resultSets.forEach(set => {
                    set.forEach(match => results.push(match));
                });
                return results;
            });
        }
    }

}

// Got quicksort implementation from https://github.com/CharlesStover/quicksort-js/blob/master/src/quicksort.ts
// modified to work with Maps instead
const defaultComparator = (a, b) => {
    if (a < b) { return -1; }
    if (a > b) { return 1; }
    return 0;
};

const quickSort = (unsortedArray, comparator = defaultComparator) => {

  // Create a sortable array to return.
  const sortedArray = [ ...unsortedArray ];

  // Recursively sort sub-arrays.
  const recursiveSort = (start, end) => {

    // If this sub-array is empty, it's sorted.
    if (end - start < 1) {
      return;
    }

    const pivotValue = sortedArray[end];
    let splitIndex = start;
    for (let i = start; i < end; i++) {
      const sort = comparator(sortedArray[i], pivotValue);

      // This value is less than the pivot value.
      if (sort === -1) {

        // If the element just to the right of the split index,
        //   isn't this element, swap them.
        if (splitIndex !== i) {
          const temp = sortedArray[splitIndex];
          sortedArray[splitIndex] = sortedArray[i];
          sortedArray[i] = temp;
        }

        // Move the split index to the right by one,
        //   denoting an increase in the less-than sub-array size.
        splitIndex++;
      }

      // Leave values that are greater than or equal to
      //   the pivot value where they are.
    }

    // Move the pivot value to between the split.
    sortedArray[end] = sortedArray[splitIndex];
    sortedArray[splitIndex] = pivotValue;

    // Recursively sort the less-than and greater-than arrays.
    recursiveSort(start, splitIndex - 1);
    recursiveSort(splitIndex + 1, end);
  };

  // Sort the entire array.
  recursiveSort(0, sortedArray.length - 1);
  return sortedArray;
};

module.exports = { 
    DataIndex,
    ArrayIndex,
    FullTextIndex,
    GeoIndex
};