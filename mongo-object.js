/*
 * @constructor
 * @param {Object} objOrModifier
 * @param {string[]} blackBoxKeys - A list of the names of keys that shouldn't be traversed
 * @returns {undefined}
 */
MongoObject = function(objOrModifier, blackBoxKeys) {
  var self = this;
  self._obj = objOrModifier;
  self._affectedKeys = {};
  self._genericAffectedKeys = {};
  self._parentPositions = [];

  function parseObj(val, currentPosition, affectedKey, operator, adjusted) {

    // Adjust for first-level modifier operators
    if (!operator && affectedKey && affectedKey.substring(0, 1) === "$") {
      operator = affectedKey;
      affectedKey = null;
    }

    var affectedKeyIsBlackBox = false;
    var affectedKeyGeneric;
    if (affectedKey) {

      // Adjust for $push and $addToSet and $pull and $pop
      if (!adjusted && (operator === "$push" || operator === "$addToSet" || operator === "$pull" || operator === "$pop")) {
        // Adjust for $each
        // We can simply jump forward and pretend like the $each array
        // is the array for the field. This has the added benefit of
        // skipping past any $slice, which we also don't care about.
        if (isBasicObject(val) && "$each" in val) {
          val = val.$each;
          currentPosition = currentPosition + "[$each]";
        } else {
          affectedKey = affectedKey + ".0";
        }
        adjusted = true;
      }

      // Make generic key
      affectedKeyGeneric = makeGeneric(affectedKey);

      // Determine whether affected key should be treated as a black box
      affectedKeyIsBlackBox = _.contains(blackBoxKeys, affectedKeyGeneric);

      // Mark that this position affects this generic and non-generic key
      if (currentPosition) {
        self._affectedKeys[currentPosition] = affectedKey;
        self._genericAffectedKeys[currentPosition] = affectedKeyGeneric;
      }
    }

    // Loop through arrays
    if (_.isArray(val) && !_.isEmpty(val)) {
      // Mark positions with objects that should be left out of flat docs.
      currentPosition && self._parentPositions.push(currentPosition);
      // Loop
      _.each(val, function(v, i) {
        parseObj(v, (currentPosition ? currentPosition + "[" + i + "]" : i), affectedKey + '.' + i, operator, adjusted);
      });
    }

    // Loop through object keys, only for basic objects,
    // but always for the passed-in object, even if it
    // is a custom object.
    else if ((isBasicObject(val) && !affectedKeyIsBlackBox) || !currentPosition) {
      // Mark positions with arrays that should be left out of flat docs.
      currentPosition && !_.isEmpty(val) && self._parentPositions.push(currentPosition);
      // Loop
      _.each(val, function(v, k) {
        if (k !== "$slice") {
          parseObj(v, (currentPosition ? currentPosition + "[" + k + "]" : k), appendAffectedKey(affectedKey, k), operator, adjusted);
        }
      });
    }

  }
  parseObj(self._obj);

  function reParseObj() {
    self._affectedKeys = {};
    self._genericAffectedKeys = {};
    self._parentPositions = [];
    parseObj(self._obj);
  }

  /**
   * @method MongoObject.forEachNode
   * @param {Function} func
   * @param {Object} [options]
   * @param {Boolean} [options.endPointsOnly=true] - Only call function for endpoints and not for nodes that contain other nodes
   * @returns {undefined}
   * 
   * Runs a function for each endpoint node in the object tree, including all items in every array.
   * The function arguments are
   * (1) the value at this node
   * (2) a string representing the node position
   * (3) the representation of what would be changed in mongo, using mongo dot notation
   * (4) the generic equivalent of argument 3, with "$" instead of numeric pieces
   */
  self.forEachNode = function(func, options) {
    if (typeof func !== "function")
      throw new Error("filter requires a loop function");

    options = _.extend({
      endPointsOnly: true
    }, options);

    var updatedValues = {};
    _.each(self._affectedKeys, function(affectedKey, position) {
      if (options.endPointsOnly && _.contains(self._parentPositions, position))
        return; //only endpoints
      func.call({
        updateValue: function(newVal) {
          updatedValues[position] = newVal;
        },
        remove: function() {
          updatedValues[position] = void 0;
        }
      }, self.getValueForPosition(position), position, affectedKey, self._genericAffectedKeys[position]);
    });

    // Actually update/remove values as instructed
    _.each(updatedValues, function(newVal, position) {
      self.setValueForPosition(position, newVal);
    });

  };

  self.getValueForPosition = function(position) {
    var subkey, subkeys = position.split("["), current = self._obj;
    for (var i = 0, ln = subkeys.length; i < ln; i++) {
      subkey = subkeys[i];
      // If the subkey ends in "]", remove the ending
      if (subkey.slice(-1) === "]") {
        subkey = subkey.slice(0, -1);
      }
      current = current[subkey];
      if (!isArray(current) && !isBasicObject(current) && i < ln - 1) {
        return;
      }
    }
    return current;
  };

  /**
   * @method MongoObject.prototype.setValueForPosition
   * @param {String} position
   * @param {Any} value
   * @returns {undefined}
   */
  self.setValueForPosition = function(position, value) {
    var nextPiece, subkey, subkeys = position.split("["), current = self._obj;

    for (var i = 0, ln = subkeys.length; i < ln; i++) {
      subkey = subkeys[i];
      // If the subkey ends in "]", remove the ending
      if (subkey.slice(-1) === "]") {
        subkey = subkey.slice(0, -1);
      }
      // If we've reached the key in the object tree that needs setting or
      // deleting, do it.
      if (i === ln - 1) {
        current[subkey] = value;
        //if value is undefined, delete the property
        if (value === void 0)
          delete current[subkey];
      }
      // Otherwise attempt to keep moving deeper into the object.
      else {
        // If we're setting (as opposed to deleting) a key and we hit a place
        // in the ancestor chain where the keys are not yet created, create them.
        if (current[subkey] === void 0 && value !== void 0) {
          //see if the next piece is a number
          nextPiece = subkeys[i + 1];
          nextPiece = parseInt(nextPiece, 10);
          current[subkey] = isNaN(nextPiece) ? {} : [];
        }

        // Move deeper into the object
        current = current[subkey];

        // If we can go no further, then quit
        if (!isArray(current) && !isBasicObject(current) && i < ln - 1) {
          return;
        }
      }
    }

    reParseObj();
  };

  /**
   * @method MongoObject.prototype.removeValueForPosition
   * @param {String} position
   * @returns {undefined}
   */
  self.removeValueForPosition = function(position) {
    self.setValueForPosition(position, void 0);
  };

  /**
   * @method MongoObject.getInfoForKey
   * @param {String} key - Non-generic key
   * @returns {undefined|Object}
   * 
   * Returns the value and operator of the requested non-generic key.
   * Example: {value: 1, operator: "$pull"}
   */
  self.getInfoForKey = function(key) {
    if (keyIsGeneric(key)) {
      return;
    }

    // Get the info
    var position = self.getPositionForKey(key);
    if (position) {
      return {
        value: self.getValueForPosition(position),
        operator: extractOp(position)
      };
    }

    // If we haven't returned yet, check to see if there is an array value
    // corresponding to this key
    // We find the first item within the array, strip the last piece off the
    // position string, and then return whatever is at that new position in
    // the original object.
    var positions = self.getPositionsForGenericKey(key + ".$"), p, v;
    for (var i = 0, ln = positions.length; i < ln; i++) {
      p = positions[i];
      v = self.getValueForPosition(p) || self.getValueForPosition(p.slice(0, p.lastIndexOf("[")));
      if (v) {
        return {
          value: v,
          operator: extractOp(p)
        };
      }
    }
  };

  /**
   * @method MongoObject.getPositionForKey
   * @param {String} key - Non-generic key
   * @returns {undefined|String} Position string
   * 
   * Returns the position string for the place in the object that
   * affects the requested non-generic key.
   * Example: 'foo[bar][0]'
   */
  self.getPositionForKey = function(key) {
    if (keyIsGeneric(key)) {
      throw new Error("MongoObject.getPositionForKey accepts non-generic keys only");
    }

    // Get the info
    for (var position in self._affectedKeys) {
      if (self._affectedKeys.hasOwnProperty(position)) {
        if (self._affectedKeys[position] === key) {
          // We return the first one we find. While it's
          // possible that multiple update operators could
          // affect the same non-generic key, we'll assume that's not the case.
          return position;
        }
      }
    }

    // If we haven't returned yet, we need to check for affected keys
  };

  /**
   * @method MongoObject.getPositionsForGenericKey
   * @param {String} key - Generic key
   * @returns {String[]} Array of position strings
   * 
   * Returns an array of position strings for the places in the object that
   * affect the requested generic key.
   * Example: ['foo[bar][0]']
   */
  self.getPositionsForGenericKey = function(key) {
    if (!keyIsGeneric(key)) {
      throw new Error("MongoObject.getPositionsForGenericKey accepts generic keys only");
    }

    // Get the info
    var list = [];
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        if (self._genericAffectedKeys[position] === key) {
          list.push(position);
        }
      }
    }

    return list;
  };

  /**
   * @deprecated Use getInfoForKey
   * @method MongoObject.getValueForKey
   * @param {String} key - Non-generic key
   * @returns {undefined|Any}
   * 
   * Returns the value of the requested non-generic key
   */
  self.getValueForKey = function(key) {
    if (keyIsGeneric(key)) {
      throw new Error("MongoObject.getArrayInfoForKey accepts non-generic keys only");
    }
    var position = self.getPositionForKey(key);
    if (position) {
      return self.getValueForPosition(position);
    }
  };

  /**
   * @method MongoObject.prototype.addKey
   * @param {String} key - Key to set
   * @param {Any} val - Value to give this key
   * @param {String} op - Operator under which to set it, or `null` for a non-modifier object
   * @returns {undefined}
   * 
   * Adds `key` with value `val` under operator `op` to the source object.
   */
  self.addKey = function(key, val, op) {
    var position = op ? op + "[" + key + "]" : MongoObject._keyToPosition(key);
    self.setValueForPosition(position, val);
  };

  /**
   * @method MongoObject.prototype.removeGenericKeys
   * @param {String[]} keys
   * @returns {undefined}
   * 
   * Removes anything that affects any of the generic keys in the list
   */
  self.removeGenericKeys = function(keys) {
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        if (_.contains(keys, self._genericAffectedKeys[position])) {
          self.removeValueForPosition(position);
        }
      }
    }
  };

  /**
   * @method MongoObject.removeGenericKey
   * @param {String} key
   * @returns {undefined}
   * 
   * Removes anything that affects the requested generic key
   */
  self.removeGenericKey = function(key) {
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        if (self._genericAffectedKeys[position] === key) {
          self.removeValueForPosition(position);
        }
      }
    }
  };

  /**
   * @method MongoObject.removeKey
   * @param {String} key
   * @returns {undefined}
   * 
   * Removes anything that affects the requested non-generic key
   */
  self.removeKey = function(key) {
    // We don't use getPositionForKey here because we want to be sure to
    // remove for all positions if there are multiple.
    for (var position in self._affectedKeys) {
      if (self._affectedKeys.hasOwnProperty(position)) {
        if (self._affectedKeys[position] === key) {
          self.removeValueForPosition(position);
        }
      }
    }
  };

  /**
   * @method MongoObject.removeKeys
   * @param {String[]} keys
   * @returns {undefined}
   * 
   * Removes anything that affects any of the non-generic keys in the list
   */
  self.removeKeys = function(keys) {
    for (var i = 0, ln = keys.length; i < ln; i++) {
      self.removeKey(keys[i]);
    }
  };

  /**
   * @method MongoObject.filterGenericKeys
   * @param {Function} test - Test function
   * @returns {undefined}
   * 
   * Passes all affected keys to a test function, which
   * should return false to remove whatever is affecting that key
   */
  self.filterGenericKeys = function(test) {
    var gk, checkedKeys = [], keysToRemove = [];
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        gk = self._genericAffectedKeys[position];
        if (!_.contains(checkedKeys, gk)) {
          checkedKeys.push(gk);
          if (gk && !test(gk)) {
            keysToRemove.push(gk);
          }
        }
      }
    }

    _.each(keysToRemove, function(key) {
      self.removeGenericKey(key);
    });
  };

  /**
   * @method MongoObject.setValueForKey
   * @param {String} key
   * @param {Any} val
   * @returns {undefined}
   * 
   * Sets the value for every place in the object that affects
   * the requested non-generic key
   */
  self.setValueForKey = function(key, val) {
    // We don't use getPositionForKey here because we want to be sure to
    // set the value for all positions if there are multiple.
    for (var position in self._affectedKeys) {
      if (self._affectedKeys.hasOwnProperty(position)) {
        if (self._affectedKeys[position] === key) {
          self.setValueForPosition(position, val);
        }
      }
    }
  };

  /**
   * @method MongoObject.setValueForGenericKey
   * @param {String} key
   * @param {Any} val
   * @returns {undefined}
   * 
   * Sets the value for every place in the object that affects
   * the requested generic key
   */
  self.setValueForGenericKey = function(key, val) {
    // We don't use getPositionForKey here because we want to be sure to
    // set the value for all positions if there are multiple.
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        if (self._genericAffectedKeys[position] === key) {
          self.setValueForPosition(position, val);
        }
      }
    }
  };

  /**
   * @method MongoObject.getObject
   * @returns {Object}
   * 
   * Get the source object, potentially modified by other method calls on this
   * MongoObject instance.
   */
  self.getObject = function() {
    return self._obj;
  };

  /**
   * @method MongoObject.getFlatObject
   * @returns {Object}
   * 
   * Gets a flat object based on the MongoObject instance.
   * In a flat object, the key is the name of the non-generic affectedKey,
   * with mongo dot notation if necessary, and the value is the value for
   * that key.
   */
  self.getFlatObject = function() {
    var newObj = {};
    _.each(self._affectedKeys, function(affectedKey, position) {
      if (typeof affectedKey === "string" && !_.contains(self._parentPositions, position)) {
        newObj[affectedKey] = self.getValueForPosition(position);
      }
    });
    return newObj;
  };

  /**
   * @method MongoObject.affectsKey
   * @param {String} key
   * @returns {Object}
   * 
   * Returns true if the non-generic key is affected by this object
   */
  self.affectsKey = function(key) {
    return !!self.getPositionForKey(key);
  };

  /**
   * @method MongoObject.affectsGenericKey
   * @param {String} key
   * @returns {Object}
   * 
   * Returns true if the generic key is affected by this object
   */
  self.affectsGenericKey = function(key) {
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        if (self._genericAffectedKeys[position] === key) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * @method MongoObject.affectsGenericKeyImplicit
   * @param {String} key
   * @returns {Object}
   * 
   * Like affectsGenericKey, but will return true if a child key is affected
   */
  self.affectsGenericKeyImplicit = function(key) {
    for (var position in self._genericAffectedKeys) {
      if (self._genericAffectedKeys.hasOwnProperty(position)) {
        var affectedKey = self._genericAffectedKeys[position];

        // If the affected key is the test key
        if (affectedKey === key) {
          return true;
        }

        // If the affected key implies the test key because the affected key
        // starts with the test key followed by a period
        if (affectedKey.substring(0, key.length + 1) === key + ".") {
          return true;
        }

        // If the affected key implies the test key because the affected key
        // starts with the test key and the test key ends with ".$"
        var lastTwo = key.slice(-2);
        if (lastTwo === ".$" && key.slice(0, -2) === affectedKey) {
          return true;
        }
      }
    }
    return false;
  };
};

/** Takes a string representation of an object key and its value
 *  and updates "obj" to contain that key with that value.
 *  
 *  Example keys and results if val is 1:
 *    "a" -> {a: 1}
 *    "a[b]" -> {a: {b: 1}}
 *    "a[b][0]" -> {a: {b: [1]}}
 *    "a[b.0.c]" -> {a: {'b.0.c': 1}}
 */

/** Takes a string representation of an object key and its value
 *  and updates "obj" to contain that key with that value.
 *  
 *  Example keys and results if val is 1:
 *    "a" -> {a: 1}
 *    "a[b]" -> {a: {b: 1}}
 *    "a[b][0]" -> {a: {b: [1]}}
 *    "a[b.0.c]" -> {a: {'b.0.c': 1}}
 * 
 * @param {any} val
 * @param {String} key
 * @param {Object} obj
 * @returns {undefined}
 */
MongoObject.expandKey = function(val, key, obj) {
  var nextPiece, subkey, subkeys = key.split("["), current = obj;
  for (var i = 0, ln = subkeys.length; i < ln; i++) {
    subkey = subkeys[i];
    if (subkey.slice(-1) === "]") {
      subkey = subkey.slice(0, -1);
    }
    if (i === ln - 1) {
      //last iteration; time to set the value; always overwrite
      current[subkey] = val;
      //if val is undefined, delete the property
      if (val === void 0)
        delete current[subkey];
    } else {
      //see if the next piece is a number
      nextPiece = subkeys[i + 1];
      nextPiece = parseInt(nextPiece, 10);
      if (!current[subkey]) {
        current[subkey] = isNaN(nextPiece) ? {} : [];
      }
    }
    current = current[subkey];
  }
};

MongoObject._keyToPosition = function keyToPosition(key, wrapAll) {
  var position = '';
  _.each(key.split("."), function (piece, i) {
    if (i === 0 && !wrapAll) {
      position += piece;
    } else {
      position += "[" + piece + "]";
    }
  });
  return position;
};

var isArray = Array.isArray || function(obj) {
  return obj.toString() === '[object Array]';
};

var isObject = function(obj) {
  return obj === Object(obj);
};

// getPrototypeOf polyfill
if (typeof Object.getPrototypeOf !== "function") {
  if (typeof "".__proto__ === "object") {
    Object.getPrototypeOf = function(object) {
      return object.__proto__;
    };
  } else {
    Object.getPrototypeOf = function(object) {
      // May break if the constructor has been tampered with
      return object.constructor.prototype;
    };
  }
}

/* Tests whether "obj" is an Object as opposed to
 * something that inherits from Object
 * 
 * @param {any} obj
 * @returns {Boolean}
 */
var isBasicObject = function(obj) {
  return isObject(obj) && Object.getPrototypeOf(obj) === Object.prototype;
};

/* Takes a specific string that uses mongo-style dot notation
 * and returns a generic string equivalent. Replaces all numeric
 * "pieces" with a dollar sign ($).
 * 
 * @param {type} name
 * @returns {unresolved}
 */
var makeGeneric = function makeGeneric(name) {
  if (typeof name !== "string")
    return null;
  return name.replace(/\.[0-9]+\./g, '.$.').replace(/\.[0-9]+/g, '.$');
};

var keyIsGeneric = function keyIsGeneric(key) {
  return (key.slice(-2) === ".$" || key.indexOf(".$.") !== -1);
};

var appendAffectedKey = function appendAffectedKey(affectedKey, key) {
  if (key === "$each") {
    return affectedKey;
  } else {
    return (affectedKey ? affectedKey + "." + key : key);
  }
};

// Extracts operator piece, if present, from position string
var extractOp = function extractOp(position) {
  var firstPositionPiece = position.slice(0, position.indexOf("["));
  return (firstPositionPiece.substring(0, 1) === "$") ? firstPositionPiece : null;
};