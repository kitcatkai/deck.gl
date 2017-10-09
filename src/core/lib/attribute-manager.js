// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

/* eslint-disable guard-for-in */
import {GL} from 'luma.gl';
import Stats from './stats';
import {log} from './utils';
import assert from 'assert';

import AttributeTransitionManager from './attribute-transition-manager';

const LOG_START_END_PRIORITY = 1;
const LOG_DETAIL_PRIORITY = 2;

function noop() {}

/* eslint-disable complexity */
export function glArrayFromType(glType, {clamped = true} = {}) {
  // Sorted in some order of likelihood to reduce amount of comparisons
  switch (glType) {
  case GL.FLOAT:
    return Float32Array;
  case GL.UNSIGNED_SHORT:
  case GL.UNSIGNED_SHORT_5_6_5:
  case GL.UNSIGNED_SHORT_4_4_4_4:
  case GL.UNSIGNED_SHORT_5_5_5_1:
    return Uint16Array;
  case GL.UNSIGNED_INT:
    return Uint32Array;
  case GL.UNSIGNED_BYTE:
    return clamped ? Uint8ClampedArray : Uint8Array;
  case GL.BYTE:
    return Int8Array;
  case GL.SHORT:
    return Int16Array;
  case GL.INT:
    return Int32Array;
  default:
    throw new Error('Failed to deduce type from array');
  }
}
/* eslint-enable complexity */

// Default loggers
const logFunctions = {
  onUpdateStart: ({level, id, numInstances}) => {
    log.time(level, `Updated attributes for ${numInstances} instances in ${id} in`);
  },
  onLog: ({level, message}) => {
    log.log(level, message);
  },
  onUpdateEnd: ({level, id, numInstances}) => {
    log.timeEnd(level, `Updated attributes for ${numInstances} instances in ${id} in`);
  }
};

export default class AttributeManager {
  /**
   * Sets log functions to help trace or time attribute updates.
   * Default logging uses deck logger.
   *
   * `onLog` is called for each attribute.
   *
   * To enable detailed control of timming and e.g. hierarchical logging,
   * hooks are also provided for update start and end.
   *
   * @param {Object} [opts]
   * @param {String} [opts.onLog=] - called to print
   * @param {String} [opts.onUpdateStart=] - called before update() starts
   * @param {String} [opts.onUpdateEnd=] - called after update() ends
   */
  static setDefaultLogFunctions({
    onLog,
    onUpdateStart,
    onUpdateEnd
  } = {}) {
    if (onLog !== undefined) {
      logFunctions.onLog = onLog || noop;
    }
    if (onUpdateStart !== undefined) {
      logFunctions.onUpdateStart = onUpdateStart || noop;
    }
    if (onUpdateEnd !== undefined) {
      logFunctions.onUpdateEnd = onUpdateEnd || noop;
    }
  }

  /**
   * @classdesc
   * Automated attribute generation and management. Suitable when a set of
   * vertex shader attributes are generated by iteration over a data array,
   * and updates to these attributes are needed either when the data itself
   * changes, or when other data relevant to the calculations change.
   *
   * - First the application registers descriptions of its dynamic vertex
   *   attributes using AttributeManager.add().
   * - Then, when any change that affects attributes is detected by the
   *   application, the app will call AttributeManager.invalidate().
   * - Finally before it renders, it calls AttributeManager.update() to
   *   ensure that attributes are automatically rebuilt if anything has been
   *   invalidated.
   *
   * The application provided update functions describe how attributes
   * should be updated from a data array and are expected to traverse
   * that data array (or iterable) and fill in the attribute's typed array.
   *
   * Note that the attribute manager intentionally does not do advanced
   * change detection, but instead makes it easy to build such detection
   * by offering the ability to "invalidate" each attribute separately.
   *
   * Summary:
   * - keeps track of valid state for each attribute
   * - auto reallocates attributes when needed
   * - auto updates attributes with registered updater functions
   * - allows overriding with application supplied buffers
   *
   * Limitations:
   * - There are currently no provisions for only invalidating a range of
   *   indices in an attribute.
   *
   * @class
   * @param {Object} [props]
   * @param {String} [props.id] - identifier (for debugging)
   */
  constructor({id = 'attribute-manager', gl, transition} = {}) {
    this.id = id;
    this.gl = gl;

    this.attributes = {};
    this.updateTriggers = {};
    this.allocedInstances = -1;
    this.needsRedraw = true;

    this.userData = {};
    this.stats = new Stats({id: 'attr'});

    this.isTransitionSupported = AttributeTransitionManager.isSupported(gl);
    this.setTransitionOptions(transition);

    // For debugging sanity, prevent uninitialized members
    Object.seal(this);
  }

  /**
   * Adds attributes
   * Takes a map of attribute descriptor objects
   * - keys are attribute names
   * - values are objects with attribute fields
   *
   * attribute.size - number of elements per object
   * attribute.updater - number of elements
   * attribute.instanced=0 - is this is an instanced attribute (a.k.a. divisor)
   * attribute.noAlloc=false - if this attribute should not be allocated
   *
   * @example
   * attributeManager.add({
   *   positions: {size: 2, update: calculatePositions}
   *   colors: {size: 3, update: calculateColors}
   * });
   *
   * @param {Object} attributes - attribute map (see above)
   * @param {Object} updaters - separate map of update functions (deprecated)
   */
  add(attributes, updaters = {}) {
    this._add(attributes, updaters);
  }

 /**
   * Removes attributes
   * Takes an array of attribute names and delete them from
   * the attribute map if they exists
   *
   * @example
   * attributeManager.remove(['position']);
   *
   * @param {Object} attributeNameArray - attribute name array (see above)
   */
  remove(attributeNameArray) {
    for (let i = 0; i < attributeNameArray.length; i++) {
      const name = attributeNameArray[i];
      if (this.attributes[name] !== undefined) {
        delete this.attributes[name];
      }
    }
  }

  /* Marks an attribute for update
   * @param {string} triggerName: attribute or accessor name
   */
  invalidate(triggerName) {
    const {attributes, updateTriggers} = this;
    const attributesToUpdate = updateTriggers[triggerName];

    if (!attributesToUpdate) {
      let message =
        `invalidating non-existent attribute ${triggerName} for ${this.id}\n`;
      message += `Valid attributes: ${Object.keys(attributes).join(', ')}`;
      assert(attributesToUpdate, message);
    }
    attributesToUpdate.forEach(name => {
      const attribute = attributes[name];
      if (attribute) {
        attribute.needsUpdate = true;
      }
    });
    // For performance tuning
    logFunctions.onLog({
      level: LOG_DETAIL_PRIORITY,
      message: `invalidated attribute ${attributesToUpdate} for ${this.id}`,
      id: this.identifier
    });
  }

  invalidateAll() {
    const {attributes} = this;
    for (const attributeName in attributes) {
      this.invalidate(attributeName);
    }
  }

  /**
   * Ensure all attribute buffers are updated from props or data.
   *
   * Note: Any preallocated buffers in "buffers" matching registered attribute
   * names will be used. No update will happen in this case.
   * Note: Calls onUpdateStart and onUpdateEnd log callbacks before and after.
   *
   * @param {Object} opts - options
   * @param {Object} opts.data - data (iterable object)
   * @param {Object} opts.numInstances - count of data
   * @param {Object} opts.buffers = {} - pre-allocated buffers
   * @param {Object} opts.props - passed to updaters
   * @param {Object} opts.context - Used as "this" context for updaters
   */
  update({
    data,
    numInstances,
    props = {},
    buffers = {},
    context = {},
    ignoreUnknownAttributes = false
  } = {}) {
    // First apply any application provided buffers
    this._checkExternalBuffers({buffers, ignoreUnknownAttributes});
    this._setExternalBuffers(buffers);

    // Only initiate alloc/update (and logging) if actually needed
    if (this._analyzeBuffers({numInstances})) {
      logFunctions.onUpdateStart({level: LOG_START_END_PRIORITY, id: this.id, numInstances});
      this.stats.timeStart();
      this._updateBuffers({numInstances, data, props, context});
      this.stats.timeEnd();
      logFunctions.onUpdateEnd({level: LOG_START_END_PRIORITY, id: this.id, numInstances});
    }

    if (this.attributeTranstionManger) {
      this.attributeTranstionManger.update(this.attributes);
    }
  }

  /**
   * Returns all attribute descriptors
   * Note: Format matches luma.gl Model/Program.setAttributes()
   * @return {Object} attributes - descriptors
   */
  getAttributes() {
    return this.attributes;
  }

  /**
   * Returns changed attribute descriptors
   * This indicates which WebGLBuggers need to be updated
   * @return {Object} attributes - descriptors
   */
  getChangedAttributes({clearChangedFlags = false}) {
    const {attributes} = this;
    const changedAttributes = {};
    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      if (attribute.changed) {
        attribute.changed = attribute.changed && !clearChangedFlags;

        // If there is transition, let the transition manager handle the update
        if (!this.attributeTranstionManger || !attribute.transition) {
          changedAttributes[attributeName] = attribute;
        }
      }
    }
    return changedAttributes;
  }

  /**
   * Returns the redraw flag, optionally clearing it.
   * Redraw flag will be set if any attributes attributes changed since
   * flag was last cleared.
   *
   * @param {Object} [opts]
   * @param {String} [opts.clearRedrawFlags=false] - whether to clear the flag
   * @return {Boolean} - whether a redraw is needed.
   */
  getNeedsRedraw({clearRedrawFlags = false} = {}) {
    let redraw = this.needsRedraw;
    redraw = redraw || this.needsRedraw;
    this.needsRedraw = this.needsRedraw && !clearRedrawFlags;
    return redraw;
  }

  /**
   * Sets the redraw flag.
   * @param {Boolean} redraw=true
   * @return {AttributeManager} - for chaining
   */
  setNeedsRedraw(redraw = true) {
    this.needsRedraw = true;
    return this;
  }

  // DEPRECATED METHODS

  /**
   * @deprecated since version 2.5, use add() instead
   * Adds attributes
   * @param {Object} attributes - attribute map (see above)
   * @param {Object} updaters - separate map of update functions (deprecated)
   */
  addInstanced(attributes, updaters = {}) {
    this._add(attributes, updaters, {instanced: 1});
  }

  // PRIVATE METHODS

  // Used to register an attribute
  _add(attributes, updaters = {}, _extraProps = {}) {

    const newAttributes = {};

    for (const attributeName in attributes) {
      // support for separate update function map
      // For now, just copy any attributes from that map into the main map
      // TODO - Attribute maps are a deprecated feature, remove
      if (attributeName in updaters) {
        attributes[attributeName] =
          Object.assign({}, attributes[attributeName], updaters[attributeName]);
      }

      const attribute = attributes[attributeName];

      const isIndexed = attribute.isIndexed || attribute.elements;
      const size = (attribute.elements && 1) || attribute.size;
      const value = attribute.value || null;

      // Initialize the attribute descriptor, with WebGL and metadata fields
      const attributeData = Object.assign(
        {
          // Ensure that fields are present before Object.seal()
          target: undefined,
          userData: {}        // Reserved for application
        },
        // Metadata
        attribute,
        {
          // State
          isExternalBuffer: false,
          needsAlloc: false,
          needsUpdate: false,
          changed: false,

          // Luma fields
          isIndexed,
          size,
          value
        },
        _extraProps
      );
      // Sanity - no app fields on our attributes. Use userData instead.
      Object.seal(attributeData);

      // Check all fields and generate helpful error messages
      this._validateAttributeDefinition(attributeName, attributeData);

      // Add to both attributes list (for registration with model)
      newAttributes[attributeName] = attributeData;
    }

    Object.assign(this.attributes, newAttributes);

    this._mapUpdateTriggersToAttributes();
  }

  // build updateTrigger name to attribute name mapping
  _mapUpdateTriggersToAttributes() {
    const triggers = {};

    for (const attributeName in this.attributes) {
      const attribute = this.attributes[attributeName];
      let {accessor} = attribute;

      // use attribute name as update trigger key
      triggers[attributeName] = [attributeName];

      // use accessor name as update trigger key
      if (typeof accessor === 'string') {
        accessor = [accessor];
      }
      if (Array.isArray(accessor)) {
        accessor.forEach(accessorName => {
          if (!triggers[accessorName]) {
            triggers[accessorName] = [];
          }
          triggers[accessorName].push(attributeName);
        });
      }
    }

    this.updateTriggers = triggers;
  }

  _validateAttributeDefinition(attributeName, attribute) {
    assert(attribute.size >= 1 && attribute.size <= 4,
      `Attribute definition for ${attributeName} invalid size`);

    // Check that either 'accessor' or 'update' is a valid function
    const hasUpdater = attribute.noAlloc ||
      typeof attribute.update === 'function' ||
      typeof attribute.accessor === 'string';
    if (!hasUpdater) {
      throw new Error(`Attribute ${attributeName} missing update or accessor`);
    }
  }

  // Checks that any attribute buffers in props are valid
  // Note: This is just to help app catch mistakes
  _checkExternalBuffers({
    buffers = {},
    ignoreUnknownAttributes = false
  } = {}) {
    const {attributes} = this;
    for (const attributeName in buffers) {
      const attribute = attributes[attributeName];
      if (!attribute && !ignoreUnknownAttributes) {
        throw new Error(`Unknown attribute prop ${attributeName}`);
      }
      // const buffer = buffers[attributeName];
      // TODO - check buffer type
    }
  }

  // Set the buffers for the supplied attributes
  // Update attribute buffers from any attributes in props
  // Detach any previously set buffers, marking all
  // Attributes for auto allocation
  /* eslint-disable max-statements */
  _setExternalBuffers(bufferMap) {
    const {attributes, numInstances} = this;

    // Copy the refs of any supplied buffers in the props
    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      const buffer = bufferMap[attributeName];
      attribute.isExternalBuffer = false;
      if (buffer) {
        const ArrayType = glArrayFromType(attribute.type || GL.FLOAT);
        if (!(buffer instanceof ArrayType)) {
          throw new Error(`Attribute ${attributeName} must be of type ${ArrayType.name}`);
        }
        if (attribute.auto && buffer.length <= numInstances * attribute.size) {
          throw new Error('Attribute prop array must match length and size');
        }

        attribute.isExternalBuffer = true;
        attribute.needsUpdate = false;
        if (attribute.value !== buffer) {
          attribute.value = buffer;
          attribute.changed = true;
          this.needsRedraw = true;
        }
      }
    }
  }
  /* eslint-enable max-statements */

  /* Checks that typed arrays for attributes are big enough
   * sets alloc flag if not
   * @return {Boolean} whether any updates are needed
   */
  _analyzeBuffers({numInstances}) {
    const {attributes} = this;
    assert(numInstances !== undefined, 'numInstances not defined');

    // Track whether any allocations or updates are needed
    let needsUpdate = false;

    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];
      if (!attribute.isExternalBuffer) {
        // Do we need to reallocate the attribute's typed array?
        const needsAlloc =
          attribute.value === null ||
          attribute.value.length / attribute.size < numInstances;
        if (needsAlloc && (attribute.update || attribute.accessor)) {
          attribute.needsAlloc = true;
          needsUpdate = true;
        }
        if (attribute.needsUpdate) {
          needsUpdate = true;
        }
      }
    }

    return needsUpdate;
  }

  /**
   * @private
   * Calls update on any buffers that need update
   * TODO? - If app supplied all attributes, no need to iterate over data
   *
   * @param {Object} opts - options
   * @param {Object} opts.data - data (iterable object)
   * @param {Object} opts.numInstances - count of data
   * @param {Object} opts.buffers = {} - pre-allocated buffers
   * @param {Object} opts.props - passed to updaters
   * @param {Object} opts.context - Used as "this" context for updaters
   */
  /* eslint-disable max-statements, complexity */
  _updateBuffers({numInstances, data, props, context}) {
    const {attributes} = this;

    // Allocate at least one element to ensure a valid buffer
    const allocCount = Math.max(numInstances, 1);

    for (const attributeName in attributes) {
      const attribute = attributes[attributeName];

      // Allocate a new typed array if needed
      if (attribute.needsAlloc) {
        const ArrayType = glArrayFromType(attribute.type || GL.FLOAT);
        attribute.value = new ArrayType(attribute.size * allocCount);
        logFunctions.onLog({
          level: LOG_DETAIL_PRIORITY,
          message: `${this.id}:${attributeName} allocated ${allocCount}`,
          id: this.id
        });
        attribute.needsAlloc = false;
        attribute.needsUpdate = true;
      }

      // Call updater function if needed
      if (attribute.needsUpdate) {
        this._updateBuffer({attribute, attributeName, numInstances, data, props, context});
      }
    }

    this.allocedInstances = allocCount;
  }

  _updateBuffer({attribute, attributeName, numInstances, data, props, context}) {
    const {update, accessor} = attribute;
    if (update) {
      // Custom updater - typically for non-instanced layers
      logFunctions.onLog({
        level: LOG_DETAIL_PRIORITY,
        message: `${this.id}:${attributeName} updating ${numInstances}`,
        id: this.id
      });
      update.call(context, attribute, {data, props, numInstances});
      this._checkAttributeArray(attribute, attributeName);
    } else if (accessor) {
      // Standard updater
      this._updateBufferViaStandardAccessor({attribute, data, props});
      this._checkAttributeArray(attribute, attributeName);
    } else {
      logFunctions.onLog({
        level: LOG_DETAIL_PRIORITY,
        message: `${this.id}:${attributeName} missing update function`,
        id: this.id
      });
    }

    attribute.needsUpdate = false;
    attribute.changed = true;
    this.needsRedraw = true;
  }
  /* eslint-enable max-statements */

  _updateBufferViaStandardAccessor({attribute, data, props}) {
    const {accessor, value, size} = attribute;
    const accessorFunc = props[accessor];

    assert(typeof accessorFunc === 'function', `accessor "${accessor}" is not a function`);

    let {defaultValue = [0, 0, 0, 0]} = attribute;
    defaultValue = Array.isArray(defaultValue) ? defaultValue : [defaultValue];
    let i = 0;
    for (const object of data) {
      let objectValue = accessorFunc(object);
      objectValue = Array.isArray(objectValue) ? objectValue : [objectValue];
      /* eslint-disable no-fallthrough, default-case */
      switch (size) {
      case 4: value[i + 3] = Number.isFinite(objectValue[3]) ? objectValue[3] : defaultValue[3];
      case 3: value[i + 2] = Number.isFinite(objectValue[2]) ? objectValue[2] : defaultValue[2];
      case 2: value[i + 1] = Number.isFinite(objectValue[1]) ? objectValue[1] : defaultValue[1];
      case 1: value[i + 0] = Number.isFinite(objectValue[0]) ? objectValue[0] : defaultValue[0];
      }
      i += size;
    }
  }

  _checkAttributeArray(attribute, attributeName) {
    const {value} = attribute;
    if (value && value.length >= 4) {
      const valid =
        Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
        Number.isFinite(value[2]) && Number.isFinite(value[3]);
      if (!valid) {
        throw new Error(`Illegal attribute generated for ${attributeName}`);
      }
    }
  }

  /**
   * Set transition options
   * @params {Object} opts - transition options
   * Returns updated attributes
   */
  setTransitionOptions(opts) {
    if (!opts) {
      this.attributeTranstionManger = null;
    } else if (this.attributeTranstionManger) {
      this.attributeTranstionManger.setOptions(opts);
    } else if (this.isTransitionSupported) {
      this.attributeTranstionManger = new AttributeTransitionManager(this, opts);
    } else {
      log.warn(0, 'WebGL2 not supported by this browser. Transition animation is disabled.');
    }
  }

  /**
   * Update attribute transition to the current timestamp
   * Returns updated attributes if any, otherwise `null`
   */
  updateTransition() {
    const {attributeTranstionManger} = this;
    const transitionUpdated = Boolean(attributeTranstionManger) && attributeTranstionManger.run();
    this.needsRedraw = this.needsRedraw || transitionUpdated;
    return transitionUpdated ? attributeTranstionManger.getAttributes() : null;
  }

}