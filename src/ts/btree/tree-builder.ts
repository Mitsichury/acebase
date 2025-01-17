import { DetailedError } from '../detailed-error';
import { NodeEntryKeyType, NodeEntryValueType } from './entry-key-type';
import { LeafEntryMetaData } from './leaf-entry-metadata';
import { LeafEntryRecordPointer } from './leaf-entry-recordpointer';
import { BPlusTree } from './tree';
import { BPlusTreeLeaf } from './tree-leaf';
import { BPlusTreeLeafEntry } from './tree-leaf-entry';
import { BPlusTreeLeafEntryValue } from './tree-leaf-entry-value';
import { BPlusTreeNode } from './tree-node';
import { BPlusTreeNodeEntry } from './tree-node-entry';
import { _sortCompare } from './typesafe-compare';
import { _checkNewEntryArgs } from './utils';

export class BPlusTreeBuilder {
    list = new Map<NodeEntryValueType, BPlusTreeLeafEntryValue | BPlusTreeLeafEntryValue[]>();
    indexedValues = 0;

    /**
     * @param {boolean} uniqueKeys
     * @param {number} [fillFactor=100]
     * @param {string[]} [metadataKeys=[]]
     */
    constructor(public uniqueKeys: boolean, public fillFactor = 100, public metadataKeys: string[] = []) {
    }

    add(key: NodeEntryValueType, recordPointer: LeafEntryRecordPointer, metadata?: LeafEntryMetaData) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        const err = _checkNewEntryArgs(key, recordPointer, this.metadataKeys, metadata);
        if (err) {
            throw err;
        }
        const entryValue = new BPlusTreeLeafEntryValue(recordPointer, metadata);
        const existing = this.list.get(key); // this.list[key]
        if (this.uniqueKeys && typeof existing !== 'undefined') {
            throw new DetailedError('unique-key-violation', `Cannot add duplicate key "${key}", tree must have unique keys`);
        }
        else if (existing) {
            (existing as BPlusTreeLeafEntryValue[]).push(entryValue);
        }
        else {
            this.list.set(key, this.uniqueKeys //this.list[key] =
                ? entryValue
                : [entryValue]);
        }
        this.indexedValues++;
    }

    /**
     * @param key
     * @param recordPointer specific recordPointer to remove. If the tree has unique keys, this can be omitted
     */
    remove(key: NodeEntryValueType, recordPointer?: LeafEntryRecordPointer) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        const isEqual = (val1: unknown, val2: unknown) => {
            if (val1 instanceof Array && val2 instanceof Array) {
                return val1.every((v,i) => val2[i] === v);
            }
            return val1 === val2;
        };
        if (this.uniqueKeys) {
            this.list.delete(key);
        }
        else {
            const entryValues = this.list.get(key) as BPlusTreeLeafEntryValue[];
            const valIndex = entryValues.findIndex(entryValue => isEqual(entryValue.recordPointer, recordPointer));
            if (~valIndex) {
                if (entryValues.length === 1) {
                    this.list.delete(key);
                }
                else {
                    entryValues.splice(valIndex, 1);
                }
            }
        }
    }

    create(maxEntries?: number) {
        // Create a tree bottom-up with all nodes filled to the max (optionally capped to fillFactor)

        const list: Array<{ key: NodeEntryKeyType; val: BPlusTreeLeafEntryValue | BPlusTreeLeafEntryValue[] }> = [];
        this.list.forEach((val, key) => {
            list.push({ key, val });
        });
        this.list.clear();
        this.list = null; // Make unusable
        list.sort((a, b) => {
            return _sortCompare(a.key, b.key);
            // if (_isLess(a.key, b.key)) { return -1; }
            // else if (_isMore(a.key, b.key)) { return 1; }
            // return 0;
        });

        //const length = Object.keys(this.list).length;
        const minNodeSize = 3; //25;
        const maxNodeSize = 255;
        const entriesPerNode = typeof maxEntries === 'number' ? maxEntries : Math.min(maxNodeSize, Math.max(minNodeSize, Math.ceil(list.length / 10)));
        const entriesPerLeaf = Math.max(minNodeSize, Math.floor(entriesPerNode * (this.fillFactor / 100)));
        const minParentEntries = Math.max(1, Math.floor(entriesPerNode / 2));
        const tree = new BPlusTree(entriesPerNode, this.uniqueKeys, this.metadataKeys);
        tree.fillFactor = this.fillFactor;

        const nrOfLeafs = Math.max(1, Math.ceil(list.length / entriesPerLeaf));
        const parentConnections = entriesPerNode+1;  // should be +1 because the > connection
        let currentLevel = 1;
        let nrOfNodesAtLevel = nrOfLeafs;
        let nrOfParentNodes = Math.ceil(nrOfNodesAtLevel / parentConnections);
        let nodesAtLevel = [] as Array<BPlusTreeNode | BPlusTreeLeaf>; //  & { prevNode?: BPlusTreeNode; nextNode?: BPlusTreeNode; prevLeaf?: BPlusTreeLeaf; nextLeaf: BPlusTreeLeaf }
        while (true) {
            // Create parent nodes
            const creatingLeafs = currentLevel === 1;
            const parentNodes = [];
            for (let i = 0; i < nrOfParentNodes; i++) {
                const node = new BPlusTreeNode(tree, null);
                if (i > 0) {
                    const prevNode = parentNodes[i-1];
                    (node as any).prevNode = prevNode;
                    (prevNode as any).nextNode = node;
                }
                parentNodes.push(node);
            }

            for (let i = 0; i < nrOfNodesAtLevel; i++) {
                // Eg 500 leafs with 25 entries each, 500/25 = 20 parent nodes:
                // When i is between 0 and (25-1), parent node index = 0
                // When i is between 25 and (50-1), parent index = 1 etc
                // So, parentIndex = Math.floor(i / 25)
                const parentIndex = Math.floor(i / parentConnections);
                const parent = parentNodes[parentIndex];

                if (creatingLeafs) {
                    // Create leaf
                    const leaf = new BPlusTreeLeaf(parent);
                    nodesAtLevel.push(leaf);

                    // Setup linked list properties
                    const prevLeaf = nodesAtLevel[nodesAtLevel.length-2];
                    if (prevLeaf) {
                        (leaf as any).prevLeaf = prevLeaf;
                        (prevLeaf as any).nextLeaf = leaf;
                    }

                    // Create leaf entries
                    const fromIndex = i * entriesPerLeaf;
                    const entryKVPs = list.slice(fromIndex, fromIndex + entriesPerLeaf);
                    entryKVPs.forEach(kvp => {
                        const entry = new BPlusTreeLeafEntry(leaf, kvp.key);
                        entry.values = this.uniqueKeys ? [kvp.val as BPlusTreeLeafEntryValue] : kvp.val as BPlusTreeLeafEntryValue[];
                        leaf.entries.push(entry);
                    });

                    const isLastLeaf = Math.floor((i+1) / parentConnections) > parentIndex
                        || i === nrOfNodesAtLevel-1;
                    if (isLastLeaf) {
                        // Have parent's gtChild point to this last leaf
                        parent.gtChild = leaf;

                        if (parentNodes.length > 1 && parent.entries.length < minParentEntries) {
                            /* Consider this order 4 B+Tree: 3 entries per node, 4 connections

                                                    12  >
                                            4  7  10 >	  ||	>
                                1  2  3 || 4  5  6 || 7  8  9 || 10  11  12 || 13 14 15

                                The last leaf (13 14 15) is the only child of its parent, its assignment to
                                parent.gtChild is right, but there is no entry to > compare to. In this case, we have to
                                move the previous leaf's parent entry to our own parent:

                                                    10  >
                                            4  7  >	   ||	13  >
                                1  2  3 || 4  5  6 || 7  8  9 || 10  11  12 || 13 14 15

                                We moved just 1 parent entry which is fine in case of an order 4 tree, floor((O-1) / 2) is the
                                minimum entries for a node, floor((4-1) / 2) = floor(1.5) = 1.
                                When the tree order is higher, it's effect on higher tree nodes becomes greater and the tree
                                becomes inbalanced if we do not meet the minimum entries p/node requirement.
                                So, we'll have to move Math.floor(entriesPerNode / 2) parent entries to our parent
                            */
                            const nrOfParentEntries2Move = minParentEntries - parent.entries.length;
                            const prevParent = (parent as any).prevNode;
                            for (let j = 0; j < nrOfParentEntries2Move; j++) {
                                const firstChild = parent.entries.length === 0
                                    ? leaf                                      // In first iteration, firstLeaf === leaf === "13 14 15"
                                    : parent.entries[0].ltChild;                // In following iterations, firstLeaf === last moved leaf "10 11 12"
                                //const prevChild = firstChild.prevChild;
                                const moveEntry = prevParent.entries.pop();     // removes "10" from prevLeaf's parent
                                const moveLeaf = prevParent.gtChild;
                                prevParent.gtChild = moveEntry.ltChild;         // assigns "7 8 9" leaf to prevLeaf's parent > connection
                                moveEntry.key = firstChild.entries[0].key;      // changes the key to "13"
                                moveLeaf.parent = parent;                       // changes moving "10 11 12" leaf's parent to ours
                                moveEntry.ltChild = moveLeaf;                   // assigns "10 11 12" leaf to <13 connection
                                parent.entries.unshift(moveEntry);              // inserts "13" entry into our parent node
                                moveEntry.node = parent;                      // changes moving entry's parent to ours
                            }
                            //console.log(`Moved ${nrOfParentEntries2Move} parent node entries`);
                        }
                    }
                    else {
                        // Create parent entry with ltChild that points to this leaf
                        const ltChildKey = list[fromIndex + entriesPerLeaf].key;
                        const parentEntry = new BPlusTreeNodeEntry(parent, ltChildKey);
                        parentEntry.ltChild = leaf;
                        parent.entries.push(parentEntry);
                    }
                }
                else {
                    // Nodes have already been created at the previous iteration,
                    // we have to create entries for parent nodes only
                    const node = nodesAtLevel[i];
                    node.parent = parent;

                    // // Setup linked list properties - not needed by BPlusTreeNode itself, but used in code below
                    // const prevNode = nodesAtLevel[nodesAtLevel.length-2];
                    // if (prevNode) {
                    //     node.prevNode = prevNode;
                    //     prevNode.nextNode = node;
                    // }

                    const isLastNode = Math.floor((i+1) / parentConnections) > parentIndex
                        || i === nrOfNodesAtLevel-1;
                    if (isLastNode) {
                        parent.gtChild = node;

                        if (parentNodes.length > 1 && parent.entries.length < minParentEntries) {
                            // This is not right, we have to fix it.
                            // See leaf code above for additional info
                            const nrOfParentEntries2Move = minParentEntries - parent.entries.length;
                            const prevParent = (parent as any).prevNode;
                            for (let j = 0; j < nrOfParentEntries2Move; j++) {
                                const firstChild = parent.entries.length === 0
                                    ? node
                                    : parent.entries[0].ltChild;

                                const moveEntry = prevParent.entries.pop();
                                const moveNode = prevParent.gtChild;
                                prevParent.gtChild = moveEntry.ltChild;
                                let ltChild = (firstChild.entries[0] as BPlusTreeNodeEntry).ltChild;
                                while (!(ltChild instanceof BPlusTreeLeaf)) {
                                    ltChild = ltChild.entries[0].ltChild;
                                }
                                // BUG in next line? Mistake discovered during TS port
                                moveEntry.key = (ltChild as BPlusTreeLeaf).entries[0].key; //firstChild.entries[0].key;
                                moveNode.parent = parent;
                                moveEntry.ltChild = moveNode;
                                parent.entries.unshift(moveEntry);
                                moveEntry.node = parent;
                            }
                            //console.log(`Moved ${nrOfParentEntries2Move} parent node entries`);
                        }
                    }
                    else {
                        let ltChild: BPlusTreeNode | BPlusTreeLeaf = (node as any).nextNode;
                        while (!(ltChild instanceof BPlusTreeLeaf)) {
                            ltChild = ltChild.entries[0].ltChild;
                        }
                        const ltChildKey = ltChild.entries[0].key; //node.gtChild.entries[node.gtChild.entries.length-1].key; //nodesAtLevel[i+1].entries[0].key;
                        const parentEntry = new BPlusTreeNodeEntry(parent, ltChildKey);
                        parentEntry.ltChild = node;
                        parent.entries.push(parentEntry);
                    }
                }
            }

            if (nrOfLeafs === 1) {
                // Very little data. Only 1 leaf
                const leaf = nodesAtLevel[0];
                leaf.parent = tree;
                tree.root = leaf;
                break;
            }
            else if (nrOfParentNodes === 1) {
                // Done
                tree.root = parentNodes[0];
                break;
            }
            currentLevel++; // Level up
            nodesAtLevel = parentNodes;
            nrOfNodesAtLevel = nodesAtLevel.length;
            nrOfParentNodes = Math.ceil(nrOfNodesAtLevel / parentConnections);
            tree.depth++;
        }

        // // TEST the tree
        // const ok = list.every(item => {
        //     const val = tree.find(item.key);
        //     if (val === null) {
        //         return false;
        //     }
        //     return true;
        //     //return  !== null;
        // })
        // if (!ok) {
        //     throw new Error(`This tree is not ok`);
        // }

        return tree;
    }

    dumpToFile(filename: string) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        fs.appendFileSync(filename, this.uniqueKeys + '\n');
        fs.appendFileSync(filename, this.fillFactor + '\n');
        for (const [key, val] of this.list) {
            const json = JSON.stringify({ key, val }) + '\n';
            fs.appendFileSync(filename, json);
        }
    }

    static fromFile(filename: string) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const entries = (fs.readFileSync(filename, 'utf8') as string)
            .split('\n')
            .map(str => str.length > 0 ? JSON.parse(str) : '');

        const last = entries.pop(); // Remove last empty one (because split \n)
        console.assert(last === '');
        const uniqueKeys = entries.shift() === 'true';
        const fillFactor = parseInt(entries.shift());
        const builder = new BPlusTreeBuilder(uniqueKeys, fillFactor);
        // while(entries.length > 0) {
        //     let entry = entries.shift();
        //     builder.list.set(entry.key, entry.val);
        // }
        for (let i = 0; i < entries.length; i++) {
            builder.list.set(entries[i].key, entries[i].val);
        }
        return builder;
    }
}
