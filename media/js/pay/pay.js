require(['cli', 'id', 'auth', 'pay/bango', 'lib/longtext'], function(cli, id, auth, bango, checkLongText) {
    "use strict";

    var bodyData = cli.bodyData;

    var LOGOUTTIMEOUT = parseInt(bodyData.logoutTimeout, 10);

    var $doc = cli.doc;
    var $body = $doc.find('body');
    var $pinEntry = $('#enter-pin');
    var $errorScreen = $('#full-screen-error');

    // Elements to be labelled if longtext is detected.
    var $longTextElms = $('footer, body');
    // Elements to be checked for overflowing text.
    var $chkLongTextElms = $('.ltchk');

    // Currently we just default false, once loggedInUser is used properly we
    // can (and will have to) put a better value here. (bug 843192)
    var loggedIn = false;

    var onLogout = function() {
        // This is the default onLogout but might be replaced by other handlers.
        console.log('[pay] default onLogout');
        auth.resetUser();
        cli.hideProgress();
        $pinEntry.hide();
        $('#login').fadeIn();
    };

    // Setup debounced resize custom event.
    cli.win.on('resize', _.debounce(function() { $doc.trigger('saferesize');}, 200));

    // Check text for overflow on resize
    $doc.on('saferesize', function() { $chkLongTextElms.checkLongText($longTextElms, true); })
        .on('check-long-text', function() { $chkLongTextElms.checkLongText($longTextElms, true);  });

    // Run immediately.
    $chkLongTextElms.checkLongText($longTextElms, true);

    // Transition in all footers to hide longtext changes.
    $('footer').addClass('visible');

    if (bodyData.flow === 'lobby') {
        var verifyUrl = bodyData.verifyUrl;
        var calledBack = false;
        cli.showProgress(bodyData.beginMsg);
        id.watch({
            onlogin: function(assertion) {
                calledBack = true;
                console.log('[pay] nav.id onlogin');
                loggedIn = true;
                cli.showProgress(bodyData.personaMsg);
                $.post(verifyUrl, {assertion: assertion})
                    .success(function(data, textStatus, jqXHR) {
                        console.log('[pay] login success');
                        bango.prepareUser(data.user_hash).done(function() {
                            if (data.needs_redirect) {
                                window.location = data.redirect_url;
                            } else {
                                console.log('[pay] requesting focus on pin (login success)');
                                cli.focusOnPin({ $toHide: $('#login'), $toShow: $('#enter-pin') });
                            }
                        });
                    })
                    .error(function(xhr) {
                        if (xhr.status === 403) {
                            console.log('[pay] permission denied after auth');
                            window.location.href = bodyData.deniedUrl;
                        }
                        console.log('[pay] login error');
                    });
            },
            onlogout: function() {
                calledBack = true;
                loggedIn = false;
                console.log('[pay] nav.id onlogout');
                onLogout();
            },
            // This can become onmatch() soon.
            // See this issue for the order of when onready is called:
            // https://github.com/mozilla/browserid/issues/2648
            onready: function() {
                if (!calledBack && cli.bodyData.loggedInUser) {
                    console.log('[pay] Probably logged in, Persona never called back');
                    console.log('[pay] Requesting focus on pin');
                    cli.focusOnPin({ $toHide: $('#login'), $toShow: $('#enter-pin') });
                }
            }
        });

    } else {
        var $entry = $('#enter-pin');
        if ($entry.length && !$entry.hasClass('hidden')) {
            console.log('[pay] Requesting focus on pin');
            cli.focusOnPin({ $toShow: $entry });
        }
    }

    if (bodyData.docomplete) {
        callPaySuccess();
    }

    $('#signin').click(function(ev) {
        console.log('[pay] signing in manually');
        ev.preventDefault();
        cli.showProgress(bodyData.personaMsg);
        id.request();
    });

    function callPaySuccess() {
        // Bug 872987 introduced the injection of the "paymentSuccess" and
        // "paymentFailed" functions within a "mozPaymentProvider" object
        // instead of injecting them in the global scope. So we need to support
        // both APIs.
        var paymentSuccess = (cli.mozPaymentProvider.paymentSuccess ||
                              window.paymentSuccess);
        // After Bug 843309 landed, there should not be any delay before the
        // mozPaymentProvider API is injected into scope, but we keep the
        // polling loop as a safe guard.
        cli.showProgress(bodyData.completeMsg);
        if (typeof paymentSuccess === 'undefined') {
            console.log('[pay] Waiting for paymentSuccess to appear in scope');
            window.setTimeout(callPaySuccess, 500);
        } else {
            console.log('[pay] payment complete, closing window');
            paymentSuccess();
        }
    }

    $('#forgot-pin').click(function(evt) {

        var anchor = $(this);
        evt.stopPropagation();
        evt.preventDefault();

        cli.showProgress();

        function runForgotPinLogout() {
            var bangoReq;
            var personaLoggedOut = $.Deferred();

            // Define a new logout handler.
            onLogout = function() {
                console.log('[pay] forgot-pin onLogout');
                // It seems necessary to nullify the logout handler because
                // otherwise it is held in memory and called on the next page.
                onLogout = function() {
                    console.log('[pay] null onLogout');
                };
                personaLoggedOut.resolve();
            };

            // Logout promises.
            var authResetUser = auth.resetUser();
            var bangoLogout = bango.logout();

            var resetLogoutTimeout = window.setTimeout(function() {
                // If the log-out times-out then abort/reject the requests/deferred.
                console.log('[pay] logout timed-out');
                authResetUser.abort();
                bangoLogout.abort();
                personaLoggedOut.reject();
            }, LOGOUTTIMEOUT);

            $.when(authResetUser, bangoLogout,  personaLoggedOut)
                .done(function _allLoggedOut() {
                    window.clearTimeout(resetLogoutTimeout);
                    // Redirect to the original destination.
                    var dest = anchor.attr('href');
                    console.log('[pay] forgot-pin logout done; redirect to', dest);
                    window.location.href = dest;
                })
                .fail(function _failedLogout() {
                    // Called when we manually abort everything
                    // or if something fails.
                    window.clearTimeout(resetLogoutTimeout);
                    cli.hideProgress();
                    $pinEntry.hide();
                    $body.addClass('full-error');
                    $errorScreen.show();

                    // Setup click handler for one time use.
                    $errorScreen.find('.button').one('click', function(e){
                        e.stopPropagation();
                        e.preventDefault();

                        cli.showProgress();
                        $errorScreen.hide();
                        $body.removeClass('full-error');
                        $pinEntry.show();
                        runForgotPinLogout();
                    });
                });

            // Finally, log out of Persona so that the user has to
            // re-authenticate before resetting a PIN.
            if (loggedIn) {
                console.log('[pay] Logging out of Persona');
                navigator.id.logout();
            } else {
                console.log('[pay] Already logged out of Persona, calling onLogout ourself.');
                onLogout();
            }
        }
        runForgotPinLogout();
    });

});
