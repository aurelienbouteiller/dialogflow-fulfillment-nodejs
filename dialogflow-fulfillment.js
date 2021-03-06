/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Debug = require('debug');
const debug = new Debug('dialogflow:debug');

// Configure logging for hosting platforms that only support console.log and console.error
debug.log = console.log.bind(console);

// Response Builder classes
const {
  RichResponse,
  TextResponse,
  CardResponse,
  ImageResponse,
  SuggestionsResponse,
  PayloadResponse,
  PLATFORMS,
  SUPPORTED_RICH_MESSAGE_PLATFORMS,
} = require('./response-builder');
const V1Agent = require('./v1-agent');
const V2Agent = require('./v2-agent');

const RESPONSE_CODE_BAD_REQUEST = 400;

/**
 * This is the class that handles the communication with Dialogflow's webhook
 * fulfillment API v1 & v2 with support for rich responses across 8 platforms and
 * Dialogflow's simulator
 */
class WebhookClient {
  /**
   * Constructor for WebhookClient object
   * To be used in the Dialogflow fulfillment webhook logic
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   *
   * @param {Object} options JSON configuration.
   * @param {Object} options.request Express HTTP request object.
   * @param {Object} options.response Express HTTP response object.
   */
  constructor(options) {
    if (!options.request) {
      throw new Error('Request can NOT be empty.');
    }
    if (!options.response) {
      throw new Error('Response can NOT be empty.');
    }

    /**
     * The Express HTTP request that the endpoint receives from the Assistant.
     * @private
     * @type {Object}
     */
    this.request_ = options.request;

    /**
     * The Express HTTP response the endpoint will return to Assistant.
     * @private
     * @type {Object}
     */
    this.response_ = options.response;

    /**
     * The agent version (v1 or v2) based on Dialogflow webhook request
     * https://dialogflow.com/docs/reference/v2-comparison
     * @type {number}
     */
    this.agentVersion = null;
    if (this.request_.body.result) {
      this.agentVersion = 1;
    } else if (this.request_.body.queryResult) {
      this.agentVersion = 2;
    }

    /**
     * List of response messages defined by the developer
     *
     * @private
     * @type {RichResponse[]}
     */
    this.responseMessages_ = [];

    /**
     * Followup event as defined by the developer
     *
     * @private
     * @type {Object}
     */
    this.followupEvent_ = null;

    /**
     * List of outgoing contexts defined by the developer
     *
     * @private
     * @type {Object[]}
     */
    this.outgoingContexts_ = [];

    /**
     * Dialogflow action or null if no value: https://dialogflow.com/docs/actions-and-parameters
     * @type {string}
     */
    this.action = null;

    /**
     * Dialogflow parameters included in the request or null if no value
     * https://dialogflow.com/docs/actions-and-parameters
     * @type {Object[]}
     */
    this.parameters = null;

    /**
     * Dialogflow contexts included in the request or null if no value
     * https://dialogflow.com/docs/contexts
     * @type {string}
     */
    this.contexts = null;

    /**
     * Dialogflow source included in the request or null if no value
     * https://dialogflow.com/docs/reference/agent/query#query_parameters_and_json_fields
     * @type {string}
     */
    this.requestSource = null;

    /**
     * Original user query as indicated by Dialogflow or null if no value
     * @type {string}
     */
    this.query = null;

    /**
     * Original request language code or locale (i.e. "en" or "en-US")
     * @type {string} locale language code indicating the spoken/written language of the original request
     */
    this.locale = null;

    /**
     * Dialogflow input contexts included in the request or null if no value
     * Dialogflow v2 API only
     * https://dialogflow.com/docs/reference/api-v2/rest/v2beta1/WebhookRequest#FIELDS.session
     * @type {string}
     */
    this.session = null;

    /**
     * Platform contants, to define platforms, includes supported platforms and unspecified
     * @example
     * const { WebhookClient } = require('dialogflow-webhook');
     * const agent = new WebhookClient({request: request, response: response});
     * const SLACK = agent.SLACK;
     *
     * @type {string}
     */
    for (let platform in PLATFORMS) {
      if (platform) {
        this[platform] = PLATFORMS[platform];
      }
    }

    if (this.agentVersion === 2) {
      this.client = new V2Agent(this);
    } else if (this.agentVersion === 1) {
      this.client = new V1Agent(this);
    } else {
      throw new Error(
        'Invalid or unknown request type (not a Dialogflow v1 or v2 webhook request).'
      );
    }
    debug(`Webhook request version ${this.agentVersion}`);

    this.client.processRequest_();
  }

  // ---------------------------------------------------------------------------
  //                   Generic Methods
  // ---------------------------------------------------------------------------

  /**
   * Sends a response back to a Dialogflow fulfillment webhook request
   *
   * @param {string[]|RichResponse[]} response additional responses to send
   * @return {void}
   * @private
   */
  send_(response) {
    if (SUPPORTED_RICH_MESSAGE_PLATFORMS.indexOf(this.requestSource) < 0
      && this.requestSource !== undefined
      && this.requestSource !== null
      && this.requestSource !== PLATFORMS.UNSPECIFIED) {
      throw new Error(`Platform is not supported.`);
    }

    // If AoG response and the first response isn't a text response,
    // add a empty text response as the first item
    if (
      this.requestSource === PLATFORMS.ACTIONS_ON_GOOGLE &&
      this.responseMessages_[0] &&
      !(this.responseMessages_[0] instanceof TextResponse) &&
      !this.existingPayload_(PLATFORMS.ACTIONS_ON_GOOGLE)
    ) {
      this.responseMessages_ = [new TextResponse(' ')].concat(
        this.responseMessages_
      );
    }

    // If no response is defined in send args, send the existing responses
    if (!response) {
      this.client.sendResponse_();
      return;
    }

    // If there is a response in the response arg,
    // add it to the response and then send all responses
    const responseType = typeof response;
    // If it's a string, make a text response and send it with the other rich responses
    if (responseType === 'string' || response instanceof RichResponse) {
      this.add(response);
    } else if (response.isArray) {
      // Of it's a list of RichResponse objects or strings (or a mix) add them
      response.forEach(this.add.bind(this));
    }
    this.client.sendResponse_();
  }

  /**
   * Add a response to be sent to Dialogflow
   *
   * @param {RichResponse|string} response an object or string representing the rich response to be added
   */
  add(response) {
    if (typeof response === 'string') {
      response = new TextResponse(response);
    }
    if (response instanceof SuggestionsResponse && this.existingSuggestion_(response.platform)) {
      this.existingSuggestion_(response.platform).addReply_(response.replies[0]);
    } else if (response instanceof RichResponse) {
      this.responseMessages_.push(response);
    } else {
      throw new Error('unknown response type');
    }
  }

  /**
   * Handles the incoming Dialogflow request using a handler or Map of handlers
   * Each handler must be a function callback.
   *
   * @param {Map|requestCallback} handler map of Dialogflow action name to handler function or
   *     function to handle all requests (regardless of Dialogflow action).
   * @return {Promise}
   */
  handleRequest(handler) {
    if (typeof handler === 'function') {
      let result = handler(this);
      let promise = result instanceof Promise ? result : Promise.resolve();
      return promise.then(() => this.send_());
    }

    if (!(handler instanceof Map)) {
      return Promise.reject( new Error(
        'handleRequest must contain a map of Dialogflow action names to function handlers'
      ));
    }

    if (handler.get(this.action)) {
      let result = handler.get(this.action)(this);
      // If handler is a promise use it, otherwise create use default (empty) promise
      let promise = result instanceof Promise ? result : Promise.resolve();
      return promise.then(() => this.send_());
    } else if (handler.get(null)) {
      let result = handler.get(null)(this);
      // If handler is a promise use it, otherwise create use default (empty) promise
      let promise = result instanceof Promise ? result : Promise.resolve();
      return promise.then(() => this.send_());
    } else {
      debug('No handler for requested action');
      this.response_
        .status(RESPONSE_CODE_BAD_REQUEST)
        .status('No handler for requested action');
      return Promise.reject(new Error('No handler for requested action'));
    }
  }

  /**
   * Find a existing suggestion response message object for a specific platform
   *
   * @param {string} platform of incoming request
   * @return {SuggestionsResponse|null} quick reply response of corresponding platform or null if no value
   * @private
   */
  existingSuggestion_(platform) {
    let existingQuickReply;
    for (let response of this.responseMessages_) {
      if (response instanceof SuggestionsResponse) {
        if (
          (!response.platform || response.platform === PLATFORMS.UNSPECIFIED) &&
          (!platform || platform === PLATFORMS.UNSPECIFIED)
        ) {
          existingQuickReply = response;
          break;
        }
        if (platform === response.platform) {
          existingQuickReply = response;
          break;
        }
      }
    }
    return existingQuickReply;
  }

  /**
   * Find a existing payload response message object for a specific platform
   *
   * @param {string} platform of incoming request
   * @return {PayloadResponse|null} Payload response of corresponding platform or null if no value
   * @private
   */
  existingPayload_(platform) {
    let existingPayload;
    for (let response of this.responseMessages_) {
      if (response instanceof PayloadResponse) {
        if (
          (!response.platform || response.platform === PLATFORMS.UNSPECIFIED) &&
          (!platform || platform === PLATFORMS.UNSPECIFIED)
        ) {
          existingPayload = response;
          break;
        }
        if (platform === response.platform) {
          existingPayload = response;
          break;
        }
      }
    }
    return existingPayload;
  }

  // ---------------------------------------------------------------------------
  //                            Contexts
  // ---------------------------------------------------------------------------

  /**
   * Set a new Dialogflow outgoing context: https://dialogflow.com/docs/contexts
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   * agent.setContext('sample context name');
   * const context = {'name': 'weather', 'lifespan': 2, 'parameters': {'city': 'Rome'}};
   * agent.setContext(context);
   *
   * @param {string|Object} context name of context or an object representing a context
   * @return {WebhookClient}
   */
  setContext(context) {
    // If developer provides a string, transform to context object, using string as the name
    if (typeof context === 'string') {
      context = {name: context};
    }
    if (context && !context.name) {
      throw new Error('context must be provided and must have a name');
    }

    this.client.addContext_(context);

    return this;
  }

  /**
   * Clear all existing outgoing contexts: https://dialogflow.com/docs/contexts
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   * agent.clearOutgoingContexts();
   *
   * @return {WebhookClient}
   */
  clearOutgoingContexts() {
    this.outgoingContexts_ = [];
    return this;
  }

  /**
   * Clear an existing outgoing context: https://dialogflow.com/docs/contexts
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   * agent.clearContext('sample context name');
   *
   * @param {string} context name of an existing outgoing context
   * @return {WebhookClient}
   */
  clearContext(context) {
    if (this.agentVersion === 1) {
      this.outgoingContexts_ = this.outgoingContexts_.filter(
        (ctx) => ctx.name !== context
      );
    } else if (this.agentVersion === 2) {
      // Take all existing outgoing contexts and filter out the context that needs to be cleared
      this.outgoingContexts_ = this.outgoingContexts_.filter(
        (ctx) => ctx.name.slice(-context.length) !== context
      );
    } else {
      debug('Couldn\'t find context');
    }
    return this;
  }

  /**
   * Get an context from the Dialogflow webhook request: https://dialogflow.com/docs/contexts
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   * let context = agent.getContext('sample context name');
   *
   * @param {string} contextName name of an context present in the Dialogflow webhook request
   * @return {Object} context context object with the context name
   */
  getContext(contextName) {
    return this.contexts.filter( (context) => context.name === contextName )[0] || null;
  }

  /**
   * Set the followup event
   *
   * @example
   * const { WebhookClient } = require('dialogflow-webhook');
   * const agent = new WebhookClient({request: request, response: response});
   * let event = agent.setFollowupEvent('sample event name');
   *
   * @param {string|Object} event string with the name of the event or an event object
   */
  setFollowupEvent(event) {
    if (typeof event === 'string') {
      event = {name: event};
    } else if (typeof event.name !== 'string' || !event.name) {
      throw new Error('Followup event must be a string or have a name string');
    }

    this.client.setFollowupEvent_(event);
  }
}

module.exports.WebhookClient = WebhookClient;
module.exports.Text = TextResponse;
module.exports.Card = CardResponse;
module.exports.Image = ImageResponse;
module.exports.Suggestion = SuggestionsResponse;
module.exports.Payload = PayloadResponse;
