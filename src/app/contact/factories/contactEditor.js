import { ContactUpdateError } from '../../../helpers/errors';

/* @ngInject */
function contactEditor(
    $rootScope,
    $state,
    eventManager,
    Contact,
    contactModal,
    contactEmails,
    contactCache,
    contactLoaderModal,
    contactSchema,
    confirmModal,
    gettextCatalog,
    networkActivityTracker,
    notification
) {
    /*
        * Add contacts
        * @param {Array} contacts
        * @return {Promise}
        */
    function create({ contacts = [], mode }) {
        const promise = Contact.add(contacts)
            .then((data) => {
                const { created, errors, total } = data;
                eventManager.call().then(() => {
                    $rootScope.$emit('contacts', {
                        type: 'contactCreated',
                        data: { created, errors, total, mode }
                    });
                });
                return data;
            });

        if (mode === 'import') {
            contactLoaderModal.activate({
                params: {
                    mode: 'import',
                    close() {
                        contactLoaderModal.deactivate();
                    }
                }
            });
        } else {
            networkActivityTracker.track(promise);
        }

        return promise;
    }

    /**
     * Summarize the results of each merge operation.
     * @param results
     * @returns {{updated: Array, removed: Array, errors: Array}}
     */
    function summarizeMergeResults(results = []) {
        return results.reduce((agg, result) => {
            if (result.updated) {
                agg.updated.push(result.updated);
            }
            if (result.removed) {
                agg.removed = agg.removed.concat(result.removed);
            }
            if (result.errors) {
                agg.errors = agg.errors.concat(result.errors);
            }
            if (result.total) {
                agg.total += result.total;
            }
            return agg;
        }, { updated: [], removed: [], errors: [], total: 0 });
    }

    /**
     * Update and remove contacts.
     * @param {object} update Contact to update
     * @param {Array} remove IDs to remove
     * @returns {Promise}
     */
    async function updateAndRemove({ update, remove = [] }) {
        // Total is the contact to update + the ones to remove.
        const total = 1 + remove.length;
        try {
            // Update the contact.
            await Contact.update(update);

            // Remove the other contacts.
            const { removed = [], errors = [] } = await Contact.remove({ IDs: remove });

            return {
                total,
                updated: update,
                removed,
                errors: errors.map(({ Error }) => Error)
            };
        } catch (error) {
            return {
                total,
                updated: error instanceof ContactUpdateError ? undefined : update,
                errors: [error.message]
            };
        }
    }

    /**
     * Announce progressbar for each group of updates.
     * @param {Array} actions
     * @param {Number} total
     */
    function mergeProgressAnnouncer({ actions = [], total = 0 }) {
        let progress = 0;
        actions.forEach((action) => {
            action.then((result) => {
                // When a group has finished, update the progress.
                progress += Math.floor((result.total * 100) / total);

                // Emit the progress bar and that the contact has updated.
                $rootScope.$emit('progressBar', { type: 'contactsProgressBar', data: { progress } });
                $rootScope.$emit('contacts', { type: 'contactUpdated', data: { contact: update } });

                return result;
            });
        });
    }

    /**
     * Merge contacts
     * @param {{ [group]: Array }} contacts
     * @returns {Promise}
     */
    async function merge(contacts) {
        contactLoaderModal.activate({
            params: {
                mode: 'merge',
                close() {
                    contactLoaderModal.deactivate();
                }
            }
        });

        const groups = Object.keys(contacts);
        // Update and/or remove for each group of contacts.
        const actions = groups.map((group) => updateAndRemove(contacts[group]));
        // Total is contact to update + contacts to remove
        const total = groups.reduce((sum, group) => sum + contacts[group].remove.length + 1, 0);

        // Announce the progress of each group for the contact loader modal.
        mergeProgressAnnouncer({ actions, total });

        // Once all the actions have completed, announce the finalisation for the concat loader modal with the summarized results.
        const promise = Promise.all(actions)
            .then(summarizeMergeResults)
            .then((summarizedResults) => {
                // To notify that some contacts have been deleted.
                $rootScope.$emit('contacts', { type: 'contactsUpdated' });

                // To finish the loading modal.
                $rootScope.$emit('contacts', { type: 'contactsMerged', data: summarizedResults });

                // To update for the deleted contacts.
                return eventManager.call();
            });

        networkActivityTracker.track(promise);

        return promise;
    }

    /**
     * Edit a contact
     * @param {Object} contact
     * @return {Promise}
     */
    function update({ contact = {} }) {
        const promise = Contact.update(contact).then(({ Contact, cards }) => {
            $rootScope.$emit('contacts', { type: 'contactUpdated', data: { contact: Contact, cards } });
            notification.success(gettextCatalog.getString('Contact edited', null, 'Success message'));
            return eventManager.call();
        });

        networkActivityTracker.track(promise);
        return promise;
    }

    /*
        * Delete contact(s)
        * @param {Array} selectContacts
        */
    function remove({ contactIDs = [], confirm = true }) {
        const success =
            contactIDs === 'all'
                ? gettextCatalog.getString('All contacts deleted', null, 'Success')
                : gettextCatalog.getPlural(contactIDs.length, 'Contact deleted', 'Contacts deleted', null, 'Success');

        const process = () => {
            return requestDeletion(contactIDs).then(() => {
                notification.success(success);
                $state.go('secured.contacts');
            });
        };

        if (confirm) {
            return confirmDeletion(contactIDs, () => process());
        }

        return process();
    }

    function requestDeletion(IDs = []) {
        const promise = IDs === 'all' ? Contact.clear() : Contact.remove({ IDs });

        networkActivityTracker.track(promise);

        return promise.then(() => {
            if (IDs === 'all') {
                contactCache.clear();
                contactEmails.clear();
            }

            return eventManager.call();
        });
    }

    function confirmDeletion(contactIDs = [], callback) {
        const message =
            contactIDs === 'all'
                ? gettextCatalog.getString('Are you sure you want to delete all your contacts?', null, 'Info')
                : gettextCatalog.getPlural(
                      contactIDs.length,
                      'Are you sure you want to delete this contact?',
                      'Are you sure you want to delete the selected contacts?',
                      null,
                      'Info'
                  );
        const title =
            contactIDs === 'all' ? gettextCatalog.getString('Delete all', null, 'Title') : gettextCatalog.getString('Delete', null, 'Title');

        confirmModal.activate({
            params: {
                title,
                message,
                confirm() {
                    callback();
                    confirmModal.deactivate();
                },
                cancel() {
                    confirmModal.deactivate();
                }
            }
        });
    }

    function add({ email, name }) {
        const contact = angular.copy(contactSchema.contactAPI);

        email && contact.vCard.add('email', email);
        name && contact.vCard.add('fn', name);

        contactModal.activate({
            params: {
                contact,
                close() {
                    contactModal.deactivate();
                }
            }
        });
    }

    $rootScope.$on('contacts', (event, { type, data = {} }) => {
        type === 'deleteContacts' && remove(data);
        type === 'updateContact' && update(data);
        type === 'createContact' && create(data);
        type === 'addContact' && add(data);
    });

    return { init: angular.noop, create, update, remove, merge };
}

export default contactEditor;
