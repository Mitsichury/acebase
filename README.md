# AceBase realtime database engine

A fast, low memory, transactional, index & query enabled NoSQL database engine and server for node.js with realtime data change notifications. Includes built-in user authentication and authorization. Inspired by the Firebase realtime database, with additional functionality and less data sharding/duplication. Capable of storing up to 2^48 (281 trillion) object nodes in a binary database file that can theoretically grow to a max filesize of 8 petabytes. AceBase can run anywhere: in the cloud, NAS, local server, your PC/Mac, Raspberry Pi, wherever you want. 

Natively supports storing of JSON objects, arrays, numbers, strings, booleans, dates and binary (ArrayBuffer) data. Custom classes can automatically be shape-shifted to and from plain objects by adding type mappings => Store a ```User```, get a ```User```. Store a ```Chat``` that has a collection of ```Messages```, get a ```Chat``` with ```Messages``` back from the database. Any class specific methods can be executed directly on the objects you get back from the db, because they will be an ```instanceof``` your class.

## Getting Started

AceBase is split up into multiple packages:
* **acebase**: local AceBase database engine ([github](https://github.com/appy-one/acebase), [npm](https://www.npmjs.com/package/acebase))
* **acebase-server**: AceBase webserver endpoint to enable remote connections ([github](https://github.com/appy-one/acebase-server), [npm](https://www.npmjs.com/package/acebase-server))
* **acebase-client**: client to access an AceBase webserver ([github](https://github.com/appy-one/acebase-client), [npm](https://www.npmjs.com/package/acebase-client))
* **acebase-core**: shared functionality, dependency of above packages ([github](https://github.com/appy-one/acebase-core), [npm](https://www.npmjs.com/package/acebase-core))

**IMPORTANT**: AceBase is in beta stage! If you run into errors, make sure you have the latest version of each package you are using. The database files created
by older releases might be incompatible with newer versions, so you might have to start from scratch after updating. **Do not use in production yet**!

### Prerequisites

AceBase currently only runs on [Node](https://nodejs.org/), as it requires the 'fs' filesystem. If you want to connect to an AceBase server from the browser, see [acebase-client](https://www.npmjs.com/package/acebase-client)

### Installing

All AceBase repositories are available through npm. You only have to install one of them, depending on your needs:

If you want to use a **local AceBase database** in your project, install the [acebase](https://github.com/appy-one/acebase) package.

```
npm i acebase
```

If you want to setup an **AceBase server**, install [acebase-server](https://github.com/appy-one/acebase-server).

```
npm i acebase-server
```

If you want to connect to a remote (or local) AceBase server, install [acebase-client](https://github.com/appy-one/acebase-client).

```
npm i acebase-client
```

## Example usage

The API is similar to that of the Firebase realtime database, with additions.

### Creating a database

Creating a new database is as simple as connecting to it. If the database file doesn't exists, it will be created automatically.

```javascript
const { AceBase } = require('acebase');
const options = { logLevel: 'log', storage: { path: '.' } }; // optional settings
const db = new AceBase('mydb', options);  // Creates or opens a database with name "mydb"

db.ready(() => {
    // database is ready to use!
})
```

### Loading data

Run ```.get``` on a reference to get the currently stored value. This is short for the Firebase syntax of ```.once("value")```

```javascript
db.ref('game/config')
.get(snapshot => {
    if (snapshot.exists()) {
        config = snapshot.val();
    }
    else {
        config = new MyGameConfig(); // use defaults
    }
});
```

Note: When loading data, the currently stored value will be wrapped and returned in a ```DataSnapshot``` object. Use ```snapshot.exists()``` to determine if the node exists, ```snapshot.val()``` to get the value. 

### Storing data

Setting the value of a node, overwriting if it exists:

```javascript
db.ref('game/config')
.set({
    name: 'Name of the game',
    max_players: 10
})
.then(ref => {
    // stored at /game/config
})
```

Note: When storing data, it doesn't matter whether the target path, and/or parent paths exist already. If you store data in _'chats/somechatid/messages/msgid/receipts'_, it will create any nonexistent node in that path.

### Updating data

Updating the value of a node merges the stored value with the new object. If the target node doesn't exist, it will be created with the passed value.

```javascript
db.ref('game/config').update({
    description: 'The coolest game in the history of mankind'
})
.then(ref => {
    // config was updated, now get the value
    return ref.get(); // shorthand for firebase syntax ref.once("value")
})
.then(snapshot => {
    const config = snapshot.val();
    // config now has properties "name", "max_players" and "description"
});
```

### Transactional updating

If you want to update data based upon its current value, and you want to make sure the data is not changed in between your ```get``` and ```update```, use ```transaction```. A transaction gets the current value, runs your callback with a snapshot. The value you return from the callback will be used to overwrite the node with. Returning ```null``` will remove the entire node, returning ```undefined``` will cancel the transaction.

```javascript
db.ref('accounts/some_account')
.transaction(snapshot => {
    // some_account is locked until its new value is returned by this callback
    var account = snapshot.val();
    if (!snapshot.exists()) {
        // Create it
        account = {
            balance: 0
        };
    }
    account.balance *= 1.02;    // Add 2% interest
    return account; // accounts/some_account will be set to the return value
});
```

Note: ```transaction``` loads the value of a node including ALL child objects. If the node you want to run a transaction on has a large value (eg many nested child objects), you might want to run the transaction on a subnode instead. If that is not possible, consider structuring your data differently.

```javascript
// Run transaction on balance only, reduces amount of data being loaded, transferred, and overwritten
db.ref('accounts/some_account/balance')
.transaction(snapshot => {
    var balance = snapshot.val();
    if (balance === null) { // snapshot.exists() === false
        balance = 0;
    }
    return balance * 1.02;    // Add 2% interest
});
```

### Removing data

You can remove data with the ```remove``` method

```javascript
db.ref('animals/dog')
.remove()
.then(() => { /* removed successfully */ )};
```

Removing data can also be done by setting or updating its value to ```null```. Any property that has a null value will be removed from the parent object node.

```javascript
// Remove by setting it to null
db.ref('animals/dog')
.set(null)
.then(ref => { /* dog property removed */ )};

// Or, update its parent with a null value for 'dog' property
db.ref('animals')
.update({ dog: null })
.then(ref => { /* dog property removed */ )};
```

### Generating unique keys

For all generic data you add, you need to create keys that are unique and won't clash with keys generated by other clients. To do this, you can have unique keys generated with ```push```. Under the hood, ```push``` uses [cuid](https://www.npmjs.com/package/cuid) to generated keys that a guaranteed to be unique.

```javascript
db.ref('users')
.push({
    name: 'Ewout',
    country: 'The Netherlands'
})
.then(userRef => {
    // user is saved, userRef points to something 
    // like 'users/jld2cjxh0000qzrmn831i7rn'
};
```

The above example generates the unique key and stores the object immediately. You can also choose to have the key generated, but store the value later. 

```javascript
const postRef = db.ref('posts').push();
console.log(`About to add a new post with key "${postRef.key}"..`);
// ... do stuff ...
postRef.set({
    title: 'My first post'
})
.then(ref => {
    console.log(`Saved post "${postRef.key}"`);
};
```

**NOTE**: This approach is recommended if you want to add multitple new objects at once, because a single update performs way faster:

```javascript
const newMessages = {};
// We got messages from somewhere else (eg imported from file or other db)
messages.forEach(message => {
    const key = db.ref('messages').push();
    newMessages[key] = message;
})
console.log(`About to add multiple messages in 1 update operation`);
db.ref('messages').update(newMessages)
.then(ref => {
    console.log(`Added all messages at once`);
};
```

### Limit nested data loading  

If your database structure is using nesting (eg storing posts in ```'users/someuser/posts'``` instead of in ```'posts'```), you might want to limit to amount of data you are retrieving in most cases. Eg: if you want to get the details of a user, but don't want to load all nested data, you can explicitly limit the nested data retrieval by passing ```exclude```, ```include```, and/or ```child_objects``` options to ```.get```:

```javascript
// Exclude specific nested data:
db.ref('users/someuser')
.get({ exclude: ['posts', 'comments'] })
.then(snap => {
    // snapshot contains all properties of 'someuser' except 
    // 'users/someuser/posts' and 'users/someuser/comments'
});

// Include specific nested data:
db.ref('users/someuser/posts')
.get({ include: ['*/title', '*/posted'] })
.then(snap => {
    // snapshot contains all posts of 'someuser', but each post 
    // only contains 'title' and 'posted' properties
})
```

**NOTE**: This enables you to do what Firebase can't: store your data in logical places, and only get the data you are interested in, fast! On top of that, you're even able to index your nested data and query it, even faster. See below for more info about that..

## Monitoring realtime data changes

You can subscribe to data events to get realtime notifications as the monitored node is being changed. When connected to a remote AceBase server, the events will be pushed to clients through a websocket connection. Supported events are:  
- ```'value'```: triggered when a node's value changes (including changes to any child value)
- ```'child_added'```: triggered when a child node is added, callback contains a snapshot of the added child node
- ```'child_changed'```: triggered when a child node's value changed, callback contains a snapshot of the changed child node
- ```'child_removed'```: triggered when a child node is removed, callback contains a snapshot of the removed child node
- ```'notify_*'```: notification only version of above events without data, see "Notify only events" below 

```javascript
// Firebase style: using callback
db.ref('users')
.on('child_added', function (newUserSnapshot) {
    // fires for all current children, 
    // and for each new user from then on
});
```
AceBase uses the same ```.on``` method signature as Firebase, but also offers a (more intuitive) way to subscribe to the events using the returned ```EventStream``` you can ```subscribe``` to. Additionally, ```subscribe``` callbacks only fire for future events, as opposed to the ```.on``` callback, which also fires for current values of events ```'value'``` and ```'child_changed'```.

```javascript
// AceBase style: using .subscribe
db.ref('users')
.on('child_added')
.subscribe(newUserSnapshot => {
    // .subscribe only fires for new children from now on
})

db.ref('users')
.on('child_removed')
.subscribe(removedChildSnapshot => {
    // removedChildSnapshot contains the removed data
    // NOTE: snapshot.exists() will return false, 
    // and snapshot.val() contains the removed child value
});

db.ref('users')
.on('child_changed')
.subscribe(userRef => {
    // Got new value for an updated user object
});
```

If you want to use ```.subscribe``` while also getting callbacks on existing data, pass ```true``` as the callback argument:
```javascript
db.ref('users/some_user')
.on('value', true) // passing true will trigger .subscribe for current value as well
.subscribe(userRef => {
    // Got current value (1st call), or new value (2nd+ call) for some_user
});
```

The ```EventStream``` returned by ```.on``` can also be used to ```subscribe``` more than once:

```javascript
const newPostStream = db.ref('posts').on('child_added');
const subscription1 = newPostStream.subscribe(childSnapshot => { /* do something */ });
const subscription2 = newPostStream.subscribe(childSnapshot => { /* do something else */ });
// To stop 1's subscription:
subscription1.stop(); 
// or, to stop all active subscriptions:
newPostStream.stop();
```

### Notify only events

In additional to the events mentioned above, you can also subscribe to their ```notify_``` counterparts which do the same, but with a reference to the changed data instead of a snapshot. This is quite useful if you want to monitor changes, but are not interested in the actual values. Doing this also saves serverside resources, and results in less data being transferred from the server. Eg: ```notify_child_changed``` will run your callback with a reference to the changed node.

## Querying data

When running a query, all child nodes of the referenced path will be matched against your set criteria and returned in any requested ```sort``` order. Pagination of results is also supported, so you can ```skip``` and ```take``` any number of results. Queries do not require data to be indexed, although this is recommended if your data becomes larger.

To filter results, multiple ```filter(key, operator, compare)``` statements can be added. The filtered results must match all conditions set (logical AND). Supported query operators are:
- ```'<'```: value must be smaller than ```compare```
- ```'<='```: value must be smaller or equal to ```compare```
- ```'=='```: value must be equal to ```compare```
- ```'!='```: value must not be equal to ```compare```
- ```'>'```: value must be greater than ```compare```
- ```'>='```: value must be greater or equal to ```compare```
- ```'exists'```: key must exist
- ```'!exists'```: key must not exist
- ```'between'```: value must be between the 2 values in ```compare``` array (```compare[0]``` <= value <= ```compare[1]```). If ```compare[0] > compare[1]```, their values will be swapped
- ```'!between'```: value must not be between the 2 values in ```compare``` array (value < ```compare[0]``` or value > ```compare[1]```). If ```compare[0] > compare[1]```, their values will be swapped
- ```'like'```: value must be a string and must match the given pattern ```compare```. Patterns are case-insensitive and can contain wildcards _*_ for 0 or more characters, and ? for 1 character. (pattern ```"Th?"``` matches ```"The"```, not ```"That"```; pattern ```"Th*"``` matches ```"the"``` and ```"That"```)
- ```'!like'```: value must be a string and must not match the given pattern ```compare```
- ```'matches'```: value must be a string and must match the regular expression ```compare```
- ```'!matches'```: value must be a string and must not match the regular expression ```compare```
- ```'in'```: value must be equal to one of the values in ```compare``` array
- ```'!in'```: value must not be equal to any value in ```compare``` array
- ```'has'```: value must be an object, and it must have property ```compare```.
- ```'!has'```: value must be an object, and it must not have property ```compare```
- ```'contains'```: value must be an array and it must contain a value equal to ```compare```
- ```'!contains'```: value must be an array and it must not contain a value equal to ```compare```

NOTE: A query does not require any ```filter``` criteria, you can also use a ```query``` to paginate your data using ```skip```, ```take``` and ```sort```. If you don't specify any of these, AceBase will use ```.take(100)``` as default. If you do not specify a ```sort```, the order of the returned values can vary between executions.

```javascript
db.query('songs')
.filter('year', 'between', [1975, 2000])
.filter('title', 'matches', /love/i)  // Songs with love in the title
.take(50)                   // limit to 50 results
.skip(100)                  // skip first 100 results
.sort('rating', false)      // highest rating first
.sort('title')              // order by title ascending
.get(snapshots => {
    // ...
});
```

To quickly convert a snapshots array to the values it encapsulates, you can call ```snapshots.getValues()```. This is a convenience method and comes in handy if you are not interested in the results' paths or keys. You can also do it yourself with ```var values = snapshots.map(snap => snap.val())```:
```javascript
db.query('songs')
.filter('year', '>=', 2018)
.get(snapshots => {
    const songs = snapshots.getValues();
});
```

By default, queries will return snapshots of the matched nodes, but you can also get references only by passing the option ```{ snapshots: false }```
```javascript
// ...
.get({ snapshots: false }, references => {
    // now we have references only, so we can decide what data to load
});
```

Instead of using the callback of ```.get```, you can also use the returned ```Promise``` which is very useful in promise chains:
```javascript
// ... in some promise chain
.then(fromYear => {
    return db.query('songs')
    .filter('year', '>=', fromYear)
    .get();
})
.then(snapshots => {
    // Got snapshots from returned promise
})

```
This also enables using ES6 syntax:
```javascript
const snapshots = await db.query('songs')
    .filter('year', '>=', fromYear)
    .get();
```


### Removing data with a query

To remove all nodes that match a query, simply call ```remove``` instead of ```get```:
```javascript
db.query('songs')
.filter('year', '<', 1950)
.remove(() => {
    // Old junk gone
}); 
```

## Indexing data

Indexing data will dramatically improve the speed of queries on your data, especially as it increases in size. Any indexes you create will be updated automatically when underlaying data is changed, added or removed. Indexes are used to speed up filters and sorts, and to limit the amount of results. NOTE: If you are connected to an external AceBase server (using ```AceBaseClient```), indexes can only be created if you are signed in as the *admin* user.

```javascript
Promise.all([
    // creates indexes if they don't exist
    db.createIndex('songs', 'year'),
    db.createIndex('songs', 'genre')
])
.then(() => {
    return db.query('songs')
    .filter('year', '==', 2010) // uses the index on year
    .filter('genre', 'in', ['jazz','rock','blues']) // uses the index on genre
    .get();
})
.then(snapshots => {
    console.log(`Got ${snapshots.length} songs`);
});
```

### Indexing scattered data with wildcards

Because nesting data is recommended in AceBase (as opposed to Firebase that discourages this), you are able to index and query data that is scattered accross your database in a structered manner. For example, you might want to store ```posts``` for each ```user``` in their own user node, and index (and query) all posts by any user:

```javascript
db.createIndex('users/*/posts', 'date') // Index date of any post by any user
.then(() => {
    let now = new Date();
    let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return db.query('users/*/posts') // query with the same wildcard
    .filter('date', '>=', today)
    .get();
})
.then(postSnapshots => {
    // Got all today's posts, of all users
});
```

**NOTE**: Wildcard queries always require an index - they will not execute if there is no corresponding index.

### Include more data in indexes (NEW!)

If your query use filters on multiple keys you could create seperate indexes on each key, but you can also include that data into a single index. This will speed up the query even more in most cases:

```javascript
db.createIndex('songs', 'year', { include: ['genre'] })
.then(() => {
    return db.query('songs')
    .filter('year', '==', 2010) // uses the index on year
    .filter('genre', 'in', ['jazz','rock','blues']) // filters indexed results of year filter: FAST!
    .get();
})
.then(snapshots => {
    // ...
});
```

If you are filtering data on one key, and are sorting on another key, it is highly recommended to include the ```sort``` key in your index on the ```filter``` key, because this will greatly increase sorting performance:

```javascript
db.createIndex('songs', 'title', { include: ['year', 'genre'] })
.then(() => {
    return db.query('songs')
    .filter('title', 'like', 'Love *') // queries the index
    .sort('genre')  // sorts indexed results: FAST!
    .sort('title')  // sorts indexed results: FAST!
    .get();
})
.then(snapshots => {
    // ...
});
```

### Special indexes (NEW!)

Normal indexes are able to index ```string```, ```number```, ```Date```, ```boolean``` and ```undefined``` (non-existent) values. To index other data, you have to create a special index. Currently supported special indexes are: **Array**, **Fulltext** and **Geo** indexes.

### Array indexes (NEW!)

Use Array indexes to dramatically improve the speed of ```"contains"``` filters on array values.
Consider the following data structure:

```javascript
chats: {
    chat1: {
        members: ['ewout','john','pete','jack'],
        ...
    }
}
```

By adding an index to the ```members``` key, this will speed up queries to get all chats a specific user is in.

```javascript
db.createIndex('chats', 'members', { type: 'array' });
.then(() => {
    return db.query('chats')
    .filter('members', 'contains', 'ewout'); // also possible without index, but now way faster
    .get()
})
.then(snapshots => {
    // Got all chats with ewout
})
```

### Fulltext indexes (NEW!)

A fulltext index will index all individual words and their relative positions in string nodes. A normal index on text nodes is only capable of searching for exact matches quickly, or proximate like/regexp matches by scanning through the index. A fulltext index makes it possible to quickly find text nodes that contain multiple words, a selection of words or parts of them, in any order in the text.

```javascript
db.createIndex('chats/*/messages', 'text', { type: 'fulltext' });
.then(() => {
    return db.query('chats/*/messages')
    .filter('text', 'fulltext:contains', `confidential OR secret OR "don't tell"`); // not possible without fulltext index
    .get()
})
.then(snapshots => {
    // Got all confidential messages
})
```

### Geo indexes (NEW!)

A geo index is able to index latitude/longitude value combinations so you can create very fast location-based queries. 

Consider the following dataset:
```javascript
landmarks: {
    landmark1: {
        name: 'I Amsterdam Sign',
        location: {
            lat: 52.359157,
            long: 4.884155
        }
    },
    landmark2: {
        name: 'Van Gogh Museum',
        location: {
            lat: 52.358407, 
            long: 4.881152
        }
    },
    landmark3: {
        name: 'Rijksmuseum',
        location: {
            lat: 52.359818, 
            long: 4.884924
        }
    },
    ...
}
```

To query all landmarks in a range of a given location, create a _geo_ index on nodes containing ```lat``` and ```long``` keys. Then use the ```geo:nearby``` filter:

```javascript
db.createIndex('landmarks', 'location', { type: 'geo' });
.then(() => {
    return db.query('landmarks')
    .filter('location', 'geo:nearby', { lat: 52.359157, long: 4.884155, radius: 100 });
    .get()
})
.then(snapshots => {
    // Got all landmarks on Museumplein in Amsterdam (in a radius of 100 meters)
})
```

Indexed locations are stored using 10 character geohashes, which have a precision of about half a square meter.

## Mapping data to custom classes

Mapping data to your own classes allows you to store and load objects to/from the database without them losing their class type. Once you have mapped a database path to a class, you won't ever have to worry about serialization or deserialization of the objects.

```javascript
// User class implementation
class User {
    constructor(plainObject) {
        this.name = plainObject.name;
    }

    serialize() {
        // (optional) method to manually serialize
        return {
            name: this.name
        }
    }
}

// Bind to all children of users node
db.types.bind("users", User);

// Create a user
let user = new User();
user.name = 'Ewout';

// Store the user in the database
db.ref('users')
.push(user)
.then(userRef => {
    // The object returned by user.serialize() was stored in the database
    return userRef.get();
})
.then(userSnapshot => {
    let user = userSnapshot.val();
    // user is an instance of class User!
})
```

If you are unable (or don't want to) to change your class constructor, add a static method to deserialize the plain object and bind to it:

```javascript
class Pet {
    // Constructor that takes multiple arguments
    constructor(animal, name) {
        this.animal = animal;
        this.name = name;
    }
    // Static method that instantiates a Pet object
    static from(obj) {
        return new Pet(obj.animal, obj.name);
    }
}
// Bind to all pets of any user, using Pet.from as deserializer
db.types.bind("users/*/pets", Pet.from, { instantiate: false }); 
```

Note: ```{ instantiate: false }``` informs AceBase that ```Pet.from``` should not be called using the ```new``` keyword.
Also note that ```class Pet``` did not implement a ```serialize``` method. In this case, AceBase will serialize the object's properties automatically. If your class contains properties that should not be serialized (eg ```get``` properties), make sure to implement a custom ```serialize``` method.

## Upgrade notices

v0.4.0 - introduced fulltext, geo and array indexes. This required making changes to the index file format, you will have to delete all index files and create them again using ```db.indexes.create```.

## Known issues

* Index building is done in memory (heap), which can cause a "v8::internal::FatalProcessOutOfMemory" (JavaScript heap out of memory) crash on larger datasets. I will refactor this to use input and output streams in a following version. UPDATE: v0.5.0+ now uses an output stream and allows for larger indexes to be created. Input stream is still on the todo list.

* Fulltext indexes are currently only able to index words with latin characters. This will be fixed in a following version.

## Authors

* **Ewout Stortenbeker** - *Initial work* - <me@appy.one>

## Contributing

If you would like to contribute to help move the project forward, you are welcome to do so!
What can you help me with?

* Bugfixes - if you find bugs please create a new issue on github. If you know how to fix one, feel free to submit a pull request or drop me an email
* Database GUI - it would be great to have a web-based GUI to browse and/or edit database content. The ```reflect``` API method can be used to get info about particular database nodes and their children, so it is already possible to selectively load info.
* Ports - If you would like to port ```AceBaseClient``` to other languages (Java, Swift, C#, etc) that would be awesome!
* Ideas - I love new ideas, share them!
* Money - I am an independant developer and many working hours were put into developing this. Being new to open sourcing my code, giving it away for free was not easy! I also have a family to feed so if you like AceBase, feel free to send me a donation 👌 My BTC address: 3EgetGDnG9vvfJzjLYdKwWvZpHwePKNJYc