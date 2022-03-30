# How Liveslots Uses the Vatstore

Each vat gets exclusive access to a portion of the kernel's `kvStore`, implemented with a simple prefix: when vat `v6` uses `syscall.vatstoreSet('key', 'value')`, the kvStore records the value in key `v6.vs.key`.

Userspace gets an attenuated object named `vatPowers.vatstore`. When userspace calls `vatPowers.vatstore.set('key', 'value')`, liveslots performs `syscall.vatstoreSet('vvs.key', value)`, which results in a kernel kvStore entry under key `v6.vs.vvs.key`.

The rest of the vat's keyspace is used by liveslots:

* virtual object Kind metainformation
* data for each virtual object
* virtual collection metainformation and entries
* reference counts for virtual objects (tracking references from other virtual objects)
* export status for virtual objects
* the id of the "baggage" object, delivered across vat upgrades

This file describes the layout of the vatstore keyspace.


# Counters

Liveslots maintains three counters to create the distinct vrefs that it transmits to the kernel. These counters are initialized the first time `startVat` is called (in the very first version of a vat), and written to the vatstore at the end of each delivery.

* `exportID`: each exported object vref (`o+NN`) and virtual/durable Kind gets the next ID
* `collectionID`: each collection gets the next ID
* `promiseID`: each exported Promise and outbound-message `result` gets the next ID

The first eleven exportIDs are consumed by liveslots during vat startup, leaving `o+10` as the first one available for userspace.

* `o+0`: root object
* `o+1`: the KindHandle Kind ID
* `o+2 .. o+9`: KindHandles for the built-in virtual/durable collections
* `o+10`: first available for userspace Remotables or Kinds


# Virtual Object Kinds

Vats can use `VatData.defineKind()` to define categories (classes) of virtual data. The effective schema for each "Kind" contains an interface name, a set of `state` property names, and a list of facet names (which may be empty, indicating a single-facet Kind).

The standard Kind is "single-facet", meaning that each instance of the virtual object yields exactly one "Representative". However many security patterns require a collection of "Facet" Representatives which share access to common state. These Facets are all created at the same time and returned in a single record called a "cohort".

`defineKind` also specifies the runtime behavior: an `init` function called to create the initial state of each instance, a `behavior` record to provide methods for each instance, and an optional `finish` function to perform post-initialization tasks like registering the new object in a collection. `defineKind` returns a "kind constructor", typically named e.g. `makeFoo()` to make instances of the "foo kind.

Each time the kind constructor is called, a new "baseref" is allocated for the cohort, and the (one or multiple) facet Representatives are created. Each Representative/Facet gets a separate vref, all of which are extensions of the baseref.

The vref is used when interacting with the kernel (in `syscall.send` etc), and in virtualized data (inside the capdata `.slots` that point to other objects). The vatstore keys that track GC refcounts and the export status use the "baseref" instead.

The vrefs are built out of three pieces:
* Kind ID, e.g. `o+11`. These are allocated from the same "Export ID" numberspace as exported Remotables (JS `Object`s marked with `Far`).
* Instance ID, an integer, "1" for the first instance of each Kind, incrementing thereafter
* Facet ID, missing for single-facet Kinds, else an integer starting with "0"

These are combined with simple delimiters: `/` between the Kind ID and the Instance ID, and `:` before the Facet ID (if any).

In a c-list or virtualized data, you may see vrefs like these:

* `o-3`: an imported Presence, pointing to some object in a different vat
* `o+0`: the root object, a plain Remotable
* `o+10`: another plain Remotable, exported from this vat or stored in virtualized data
* `o+11/1`: a Representative for the first instance of single-facet Kind "o+11"
* `o+11/2`: a Representative for the second instance of single-facet Kind "o+11"
* `o+12/1:0`: the first facet of the first instance of a multi-facet Kind "o+12"
* `o+12/1:1`: the second facet of that same instance
* `o+12/2:0`: the first facet of a different instance
* `o+12/3:0`: the first facet of another different instance

Each instance of a virtual object stores state in a vatstore key indexed by the baseref. If `o+12/1:0` and `o+12/1:1` are the facet vrefs for a cohort whose baseref is `o+12/1`, the cohort's shared state will be stored in `vs.vom.o+12/1`, as a JSON-serialized record. The keys of this record are property names: if the Kind uses `state.prop1`, the record will have a key named `prop1`. For each property, the value is a capdata structure: a record with two properties `body` and `slots`.

* `v6.vs.vom.o+12/1` : `{"prop1":{"body":"1","slots":[]}}`

In the refcounting portion of the vatstore (`vs.vom.rc.${baseref}`), you will see baserefs:

* `v6.vs.vom.rc.o+10`: number of virtualized references to a plain Remotable (held in RAM)
* `v6.vs.vom.rc.o+12/1`: refs to any member of the cohort for instance "1" of Kind "o+12"
  * this Kind might single-facet or mult-facet
  * if multi-facet, and one object points to both `o+12/1:0` and `o+12/1:1`, the refcount would be "2"

In the export-status portion of the vatstore (`vs.vom.es.${baseref}`), you will see baserefs, and any facets are tracked in the value, not the key:

* `v6.vs.vom.es.o+10`: `r`: the plain Remotable has been exported and is "reachable" by the kernel
* `v6.vs.vom.es.o+10`: `s`: the Remotable was exported, the kernel dropped it, and is still "recognizable" by the kernel ("s" for "see")
  * if the kernel can neither reach nor recognize the export, the vatstore key will be missing entirely
* `v6.vs.vom.es.o+11/1`: this records the export status for the single-facet `o+11/1` virtual object
  * since this Kind is single-facet, the value will be the same as for a plain Remotable: a single `r` or `s` character
* `v6.vs.vom.es.o+12/1`: this records the export status for all facets of the `o+12/1` cohort
  * since this Kind is multi-facet, the value will be a string with one letter for each facet, in the same order as their Facet ID. `n` is used to indicate neither reachable nor recognizable. A value of `rsnr` means there are four facets, the first (`o+12/1:0`) and last (`o+12/1:3`) are reachable, the second (`o+12/1:1`) is recognizable, and the third (`o+12/1:2`) is neither.


# Durable Kinds

Virtual objects are held on disk, not RAM, which makes them suitable for high-cardinality data: many objects, most of which are "idle" at any given time. However virtual objects do not survive a vat upgrade. For this, vats should define one or more "Durable Kinds" instead.

Durable Kinds are defined just like virtual Kinds, but they use a different constructor (`defineDurableKind` instead of `defineKind`), which requires a "handle" created by `makeKindHandle`. Durable virtual objects can only hold durable data in their `state`.

The KindHandle is a durable virtual object of a special internal Kind. This is the first Kind allocated, so it generally gets Kind ID "1", and the handles will get vrefs of `o+1/N`.


# Virtual/Durable Collections (aka Stores)

Liveslots provides a handful of "virtual collection" types to vats, to store high-cardinality data on disk rather than in RAM. These are also known as a `Store`. They provide limited range queries and offer a single fixed sort index: numbers sort as usual, BigInts sort as usual but separate from numbers, strings sort lexicographically by UTF-8 encoding, and object references sort by insertion order).

Collections are created by functions on the `VatStore` global, which currently has four:

* `makeScalarBigMapStore`
* `makeScalarBigWeakMapStore`
* `makeScalarBigSetStore`
* `makeScalarBigWeakSetStore`

Each function accepts an `isDurable` argument, so there are currently 8 collection types.

Each collection type is assigned a Kind index, just like the user-defined Kinds. The 8 collection types are allocated before userspace gets a chance to call `defineKind` or `defineDurableKind`, so they claim earlier ID numbers.

These index values are stored in `vs.storeKindIDTable`, as a mapping from the collection type name (`scalarMapStore`, `scalarDurableMapStore`, `scalarWeakSetStore`, etc) to the integer of their ID. The current table assignments are:

* `v6.vs.storeKindIDTable` : `{"scalarMapStore":2,"scalarWeakMapStore":3,"scalarSetStore":4,"scalarWeakSetStore":5,"scalarDurableMapStore":6,"scalarDurableWeakMapStore":7,"scalarDurableSetStore":8,"scalarDurableWeakSetStore":9}`

which means `o+2` is the Kind ID for non-durable merely-virtual `scalarMapStore`.

Each new store, regardless of type, is allocated the next available Collection ID. This is an incrementing integer that starts at "1", and is independent of the numberspace used by exported Remotables and Kind IDs. The same Collection ID numberspace is shared by all collection types. So unlike virtual objects (where `o+NN/MM` means the MM is scoped to `o+NN`), for collections `o+NN/MM` means the `MM` is global to the entire vat. No two stores will have the same `MM`, even if they are of different types.

When interpreting a vref, to interpret the portion after the slash (before any colon), you must know whether the initial portion (`o+NN`) refers to a virtual object kind, or a collection type:

* `o+11/1` : `o+11` is a kind, so `/1` refers to the first instance of that kind
* `o+11/2` : second instance of that kind
*
* `o+6/1` : `o+6` is a collection type (scalarDurableMapStore), so `/1` refers to the first collection in the vat
* `o+7/2` : second collection in the vat, which happens to be of type `o+7` (scalarDurableWeakMapStore)
* `o+5/3` : third collection in the vat, of type `o+5` (scalarWeakSetStore)
* `o+5/4` : fourth collection in the vat, also a scalarWeakSetStore


# Baggage

Most collections are created by userspace code, but to support vat upgrade, liveslots creates one special collection named "baggage". This is a `scalarDurableMapStore` that is passed into the third argument of `buildRootObject`.

This object needs to be pre-generated because the second (and subsequent) versions of the vat will use it to reach all other durable objects from their predecessors, so v2 can remember things that were stored by v1. The most significant values of "baggage" are the KindHandles for durable Kinds made by v1. V2 will need these to call `defineDurableKind` and re-attach behavior for each one. Each version is obligated to re-attach behavior for *all* durable Kinds created by their predecessor, to satisfy the obligates created when the older version exported durable objects of those Kinds.

`o+6/1` is allocated for the "baggage" collection, indicating that it is a `scalarDurableMapStore` (`o+6` is used for that collection type), and also that it is the first collection (of any type) allocated in the vat.

If userspace (version 1) starts `buildRootObject` by calling `makeScalarBigWeakSetStore()` and then three `makeScalarSetStore()`s, they are likely to be assigned `o+5/2`, `o+4/3`, `o+4/4`, and `o+4/5` respectively. The collections IDs start with "2" because "1" was used for baggage.


# Collection Data Records

We examine a vat which performs the following at startup:

```js
const makeFoo = VatData.defineKind('foo',
				   (arg) => ({ prop1: arg }),
				   (state) => ({ doFoo: () => state.prop1 }),
				  );
const foo = makeFoo(1);
const foo2 = makeFoo(2);
const c1 = VatData.makeScalarBigMapStore('mylabel');
c1.init('key1', foo);
c1.init('key2', foo);
c1.init('key3', foo);
c1.init('key4', foo2);
```

Each collection stores a number of metadata keys in the vatstore, all with a prefix of `vs.vc.${collectionID}.|` (note that the collection *type* is not a part of the key, only the collection *index*). The currently defined metadata keys (copied from the record for the "mylabel" Kind stored in `c1`) are:

* `v6.vs.vc.2.|entryCount`: `4`: the size of the collection (4 entries = 4 calls to `init`)
* `v6.vs.vc.2.|label`:  `mylabel`: a debugging label applied when the collection is created
* `v6.vs.vc.2.|nextOrdinal`: `1` : a counter used to allocate index values for Objects used as keys
* `v6.vs.vc.2.|schemata`: `{"body":"[{\"@qclass\":\"tagged\",\"tag\":\"match:scalar\",\"payload\":{\"@qclass\":\"undefined\"}}]","slots":[]}`

The `schemata` is a capdata serialization of the constraints recorded for the collection. These constraints can limit keys to be just strings, or numbers, etc. The schemata consists of one schema for the keys and a separate schema for the values.

Each entry in the collection gets put into a single vatstore entry:

* `v6.vs.vc.2.skey1`: `{"body":"{\"@qclass\":\"slot\",\"iface\":\"Alleged: foo\",\"index\":0}","slots":["o+9/1"]}`
* `v6.vs.vc.2.skey2`: `{"body":"{\"@qclass\":\"slot\",\"iface\":\"Alleged: foo\",\"index\":0}","slots":["o+9/1"]}`
* `v6.vs.vc.2.skey3`: `{"body":"{\"@qclass\":\"slot\",\"iface\":\"Alleged: foo\",\"index\":0}","slots":["o+9/1"]}`
* `v6.vs.vc.2.skey4`: `{"body":"{\"@qclass\":\"slot\",\"iface\":\"Alleged: foo\",\"index\":0}","slots":["o+9/2"]}`

The key string for the entry (e.g. `skey1` is formed by serializing the key object. Strings get a simple `s` prefix. Other objects use more complex encodings, designed to allow numbers (floats and BigInts, separately) sort numerically despite the kvStore keys sorting lexicographically. See `packages/store/src/patterns/encodePassable.js` for details. Object references involve an additional kvStore entry, to manage the mapping from Object to ordinal and back.
