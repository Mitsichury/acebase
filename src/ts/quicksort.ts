/**
 * Faster quicksort using a stack to eliminate recursion, sorting inplace to reduce memory usage, and using insertion sort for small partition sizes.
 * 
 * Original author unknown.
 * I (Ewout Stortenbeker) isolated the fast quicksort code from benchmark (see below), ported to TypeScript and added custom sort function argument.
 *
 * Benchmark results at https://www.measurethat.net/Benchmarks/Show/3549/0/javascript-sorting-algorithms indicate this algorithm is at least 10x faster
 * than the native sort function (tested on Chrome v101, June 2022). My own tests (using sort function callbacks) indicate it's typically 1.5x faster than 
 * the native sort algorithm. This difference is probably caused by the built-in sort being called with a callback function in the benchmark, all others 
 * with basic < and > operators, which are obviously faster than callbacks.
 * 
 * @param arr array to sort
 * @param compareFn optional compare function to use. Must return a negative value if a < b, 0 if a == b, positive number if a > b
 * @returns 
 */
export default function fastQuickSort<T = any>(arr: T[], compareFn: (a: T, b: T) => number = (a, b) => (a as unknown as number) - (b as unknown as number)) {
    if (arr.length <= 1) {
        // No sorting needed, fixes #118
        return arr;
    }
    const stack = [];
    let entry = [
        0,
        arr.length,
        2 * Math.floor(Math.log(arr.length) / Math.log(2))
    ];
    stack.push(entry);
    while (stack.length > 0) {
        entry = stack.pop();
        var start = entry[0];
        var end = entry[1];
        var depth = entry[2];
        if (depth == 0) {
            arr = shellSortBound(arr, start, end, compareFn);
            continue;
        }
        depth--;
        var pivot = Math.round((start + end) / 2);

        var pivotNewIndex = inplaceQuickSortPartition(arr, start, end, pivot, compareFn);
        if (end - pivotNewIndex > 16) {
            entry = [pivotNewIndex, end, depth];
            stack.push(entry);
        }
        if (pivotNewIndex - start > 16) {
            entry = [start, pivotNewIndex, depth];
            stack.push(entry);
        }
    }
    arr = insertionSort(arr, compareFn);
    return arr;
}
function shellSortBound<T = any>(arr: T[], start: number, end: number, compareFn: (a: T, b: T) => number) {
    let inc = Math.round((start + end) / 2),
        i: number,
        j: number,
        t: T;

    while (inc >= start) {
        for (i = inc; i < end; i++) {
            t = arr[i];
            j = i;
            while (j >= inc && compareFn(arr[j - inc], t) > 0) { // arr[j - inc] > t
                arr[j] = arr[j - inc];
                j -= inc;
            }
            arr[j] = t;
        }
        inc = Math.round(inc / 2.2);
    }

    return arr;
}
function swap(arr: any[], a: number, b: number) {
    var t = arr[a];
    arr[a] = arr[b];
    arr[b] = t;
}

// Insertion sort
function insertionSort(arr: any[], compareFn: (a: any, b: any) => number) {
    for (let i = 1, l = arr.length; i < l; i++) {
        let value = arr[i];
        for (var j = i - 1; j >= 0; j--) {
            if (compareFn(arr[j], value) <= 0) // arr[j] <= value
                break;

            arr[j + 1] = arr[j];
        }
        arr[j + 1] = value;
    }
    return arr;
}

// In place quicksort
function inplaceQuickSortPartition(arr: any[], start: number, end: number, pivotIndex: number, compareFn: (a: any, b: any) => number) {
    var i = start,
        j = end;
    var pivot = arr[pivotIndex];

    while (true) {
        while (compareFn(arr[i], pivot) < 0) { // arr[i] < pivot
            i++;
        }
        j--;
        while (compareFn(pivot, arr[j]) < 0) { // pivot < arr[j]
            j--;
        }
        if (!(i < j)) {
            return i;
        }
        swap(arr, i, j);
        i++;
    }
}
