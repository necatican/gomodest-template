import {writable} from "svelte/store";
import isEqual from "lodash.isequal";

const reopenTimeouts = [2000, 5000, 10000, 30000, 60000];

const jsonRPC2Message = (method, params, id) => {
    if (id) {
        id = `${method}:${id}`
    }
    return {
        jsonrpc: "2.0",
        method: method,
        id: id,
        params: params
    }
}

const createJsonrpc2Socket = (url, socketOptions) => {
    let socket, openPromise, reopenTimeoutHandler;
    let reopenCount = 0;
    const messageHandlers = new Set();
    const prefixedMessageHandlers = new Map()


    // socket code copied from https://github.com/arlac77/svelte-websocket-store/blob/master/src/index.mjs
    // thank you https://github.com/arlac77 !!
    function reopenTimeout() {
        const n = reopenCount;
        reopenCount++;
        return reopenTimeouts[
            n >= reopenTimeouts.length - 1 ? reopenTimeouts.length - 1 : n
            ];
    }

    function closeSocket() {
        if (reopenTimeoutHandler) {
            clearTimeout(reopenTimeoutHandler);
        }

        if (socket) {
            socket.close();
            socket = undefined;
        }
    }

    function reOpenSocket() {
        closeSocket();
        if (messageHandlers.size > 0) {
            reopenTimeoutHandler = setTimeout(() => openSocket(), reopenTimeout());
        }
    }

    async function openSocket() {
        if (reopenTimeoutHandler) {
            clearTimeout(reopenTimeoutHandler);
            reopenTimeoutHandler = undefined;
        }

        // we are still in the opening phase
        if (openPromise) {
            return openPromise;
        }

        socket = new WebSocket(url, socketOptions);

        socket.onmessage = event => {
            const eventData = JSON.parse(event.data);
            if (eventData.id) {
                let found = false;
                prefixedMessageHandlers.forEach((messageHandler, prefix) => {
                    if (eventData.id.startsWith(prefix)) {
                        messageHandler(eventData);
                        found = true
                    }
                })
                // send it all subscribed without prefix
                if (!found) {
                    messageHandlers.forEach(messageHandler => messageHandler(eventData));
                }
            } else {
                messageHandlers.forEach(messageHandler => messageHandler(eventData));
            }
        };

        socket.onclose = event => reOpenSocket();

        openPromise = new Promise((resolve, reject) => {
            socket.onerror = error => {
                reject(error);
                openPromise = undefined;
            };
            socket.onopen = event => {
                reopenCount = 0;
                resolve();
                openPromise = undefined;
            };
        });
        return openPromise;
    }

    openSocket();
    return {
        newStore: (initialValue, methodHandlers, methodPrefix) => {
            const {subscribe, set, update} = writable(initialValue);
            const methods = Object.keys(methodHandlers);
            const statusHandlers = new Map();
            let changeCount = 0;

            const messageHandler = (message) => {
                if (isEqual(message, initialValue)) {
                    return;
                }

                if (!message.id) {
                    if (methods.includes('error')) {
                        methodHandlers['error'](undefined, 'response id is undefined')
                    }
                    return;
                }

                let method = message.id;
                if (method.includes(":")) {
                    const parts = method.split(":");
                    if (parts.length === 2) {
                        method = parts[0];
                    }
                }

                if (!methods.includes(method)) {
                    if (methods.includes('error')) {
                        methodHandlers['error'](undefined, `response id ${message.id} has no changeEvent handlers`)
                    }
                    return;
                }

                const statusHandler = statusHandlers.get(message.id)
                if (message.error) {
                    if (methods.includes('error')) {
                        methodHandlers['error'](undefined, message.error)
                    }
                    if(statusHandler) {
                        statusHandler(message.error)
                    }
                    return;
                }

                if (!message.result) {
                    if (methods.includes('error')) {
                        methodHandlers['error'](undefined, 'result is undefined')
                    }
                    if(statusHandler) {
                        statusHandler({message: 'result is undefined'})
                    }
                    return;
                }
                if(statusHandler) {
                    statusHandler();
                }

                const methodHandler = methodHandlers[method]
                update((data) => methodHandler(data, message.result))
            }
            if (methodPrefix) {
                prefixedMessageHandlers.set(methodPrefix, messageHandler);
            } else {
                messageHandlers.add(messageHandler)
            }

            return {
                subscribe,
                dispatch: (method, params) => {
                    if (!method){
                        throw 'method is required';
                    }
                    const {subscribe: subscribeStatus, set: setStatus, update: updateStatus} = writable({
                        loading: true,
                        error: undefined
                    });
                    changeCount +=1
                    const message = jsonRPC2Message(method, params, changeCount);
                    const send = () => socket.send(JSON.stringify(message));
                    if (!socket || socket && socket.readyState !== WebSocket.OPEN) openSocket().then(send);
                    else send();

                    const statusHandlerKey = `${method}:${changeCount}`;
                    const statusHandler = (error) => {
                        setStatus({
                            loading: false,
                            error: error
                        })
                        statusHandlers.delete(statusHandlerKey);
                    }
                    statusHandlers.set(statusHandlerKey, statusHandler);
                    return {
                        subscribe: subscribeStatus
                    }

                },
                close: () => {
                    if (methodPrefix) {
                        prefixedMessageHandlers.delete(methodPrefix);
                    } else {
                        messageHandlers.delete(messageHandler)
                    }
                    if (prefixedMessageHandlers.size === 0 && messageHandlers.size === 0) {
                        closeSocket();
                    }
                }
            }
        }
    }
}

export {
    createJsonrpc2Socket,
}