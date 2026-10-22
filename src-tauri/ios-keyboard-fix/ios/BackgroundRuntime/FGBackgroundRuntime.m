#import "FGBackgroundRuntime.h"
#import "FGBackgroundState.h"
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <libkern/OSByteOrder.h>
#import <objc/message.h>
#import <unistd.h>

// What keeps the app running is a silent sound in the audio background mode,
// which any sideloaded build can use. On TrollStore, where the app may carry a
// private entitlement, RunningBoard assertions on the app and on WebKit's own
// processes are added on top; they are an extra, never a requirement.
// Runtime-loaded SPI: no dependency on a private SDK or a root helper.
// See docs/IOS-BACKGROUND.md for the history and device tests.
@interface NSObject (FGRunningBoardSPI)
+ (id)targetWithPid:(pid_t)pid;
+ (id)attributeWithDomain:(NSString *)domain name:(NSString *)name;
- (id)initWithExplanation:(NSString *)explanation target:(id)target attributes:(NSArray *)attributes;
- (BOOL)acquireWithError:(NSError **)error;
- (void)addObserver:(id)observer;
- (void)removeObserver:(id)observer;
- (void)invalidate;
@end

static NSString *const PreferenceKey = @"fg.backgroundExecution";
static NSString *const Entitlement = @"com.apple.runningboard.assertions.webkit";

static BOOL ReadPreference(WKPreferences *preferences, NSString *getter) {
    return ((BOOL (*)(id, SEL))objc_msgSend)(preferences, NSSelectorFromString(getter));
}

static void WritePreference(WKPreferences *preferences, NSString *setter, BOOL value) {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(preferences, NSSelectorFromString(setter), value);
}

// The PID WebKit reports through one of its SPI getters, or 0.
static pid_t ProcessIdentifier(id object, NSString *getter) {
    SEL selector = NSSelectorFromString(getter);
    if (!object || ![object respondsToSelector:selector]) return 0;
    return ((pid_t (*)(id, SEL))objc_msgSend)(object, selector);
}

static NSString *ErrorText(NSError *error) {
    return error ? [NSString stringWithFormat:@"%@ (%ld)", error.domain, (long)error.code] : @"no error given";
}

// One second of 8 kHz mono 16-bit silence as a WAV file, looped forever.
static NSData *SilentWave(void) {
    const uint32_t rate = 8000;
    const uint32_t size = rate * 2;
    NSMutableData *wave = [NSMutableData dataWithLength:44 + size];
    uint8_t *bytes = wave.mutableBytes;
    memcpy(bytes, "RIFF", 4);
    OSWriteLittleInt32(bytes, 4, 36 + size);
    memcpy(bytes + 8, "WAVEfmt ", 8);
    OSWriteLittleInt32(bytes, 16, 16);
    OSWriteLittleInt16(bytes, 20, 1);
    OSWriteLittleInt16(bytes, 22, 1);
    OSWriteLittleInt32(bytes, 24, rate);
    OSWriteLittleInt32(bytes, 28, rate * 2);
    OSWriteLittleInt16(bytes, 32, 2);
    OSWriteLittleInt16(bytes, 34, 16);
    memcpy(bytes + 36, "data", 4);
    OSWriteLittleInt32(bytes, 40, size);
    return wave;
}

static NSString *EntitlementFailure(NSString **detail) {
    // Resolve against Security explicitly; a failed lookup is not evidence
    // that TrollStore omitted the entitlement.
    typedef CFTypeRef (*CreateTask)(CFAllocatorRef);
    typedef CFTypeRef (*CopyValue)(CFTypeRef, CFStringRef, CFErrorRef *);
    static void *security;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY | RTLD_LOCAL);
    });
    if (!security) { *detail = @"Security framework could not be loaded"; return @"security-api"; }
    CreateTask create = (CreateTask)dlsym(security, "SecTaskCreateFromSelf");
    CopyValue copy = (CopyValue)dlsym(security, "SecTaskCopyValueForEntitlement");
    if (!create || !copy) {
        *detail = !create ? @"SecTaskCreateFromSelf missing" : @"SecTaskCopyValueForEntitlement missing";
        return @"security-api";
    }
    CFTypeRef task = create(kCFAllocatorDefault);
    if (!task) { *detail = @"SecTaskCreateFromSelf returned NULL"; return @"entitlement-read"; }
    CFErrorRef error = NULL;
    CFTypeRef value = copy(task, (__bridge CFStringRef)Entitlement, &error);
    BOOL granted = value && CFEqual(value, kCFBooleanTrue);
    NSString *failure = @"";
    if (!granted) {
        failure = error ? @"entitlement-read" : @"entitlement-missing";
        *detail = error ? [NSString stringWithFormat:@"%@ (%ld)", CFErrorGetDomain(error), (long)CFErrorGetCode(error)]
                        : [Entitlement stringByAppendingString:@" is absent or false"];
    }
    if (error) CFRelease(error);
    if (value) CFRelease(value);
    CFRelease(task);
    return failure;
}

// RunningBoard may retain its observer. Do not make the runtime its own
// observer: that would keep the assertion alive after a webview is replaced.
@interface FGAssertionObserver : NSObject
@property (copy) void (^invalidated)(id assertion);
@end

@implementation FGAssertionObserver
- (void)assertion:(id)assertion didInvalidateWithError:(NSError *)error {
    if (self.invalidated) self.invalidated(assertion);
}
@end

@implementation FGBackgroundRuntime {
    __weak WKWebView *_webView;
    BOOL _on;
    NSString *_failure;
    NSString *_detail;
    // The silent sound that keeps the app running, and what became of it.
    AVAudioPlayer *_silence;
    NSString *_soundStatus;
    NSUInteger _interruptions;
    NSUInteger _restarts;
    // TrollStore extra: assertions on the app and on WebKit's processes.
    id _assertion;
    FGAssertionObserver *_observer;
    NSString *_extraStatus;
    NSDictionary<NSString *, NSNumber *> *_savedPreferences;
    NSNumber *_savedSchedulingPolicy;
    NSMutableDictionary<NSString *, id> *_helpers;
    NSMutableDictionary<NSString *, NSNumber *> *_helperPids;
    NSMutableDictionary<NSString *, NSString *> *_helperStatus;
}

- (instancetype)initWithWebView:(WKWebView *)webView {
    if ((self = [super init])) {
        _webView = webView;
        _failure = @"";
        _detail = @"";
        _soundStatus = @"off";
        _extraStatus = @"off";
        _helpers = [NSMutableDictionary dictionary];
        _helperPids = [NSMutableDictionary dictionary];
        _helperStatus = [NSMutableDictionary dictionary];
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            dlopen("/System/Library/PrivateFrameworks/RunningBoardServices.framework/RunningBoardServices", RTLD_LAZY | RTLD_LOCAL);
        });
        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        [center addObserver:self selector:@selector(didBecomeActive:)
            name:UIApplicationDidBecomeActiveNotification object:nil];
        [center addObserver:self selector:@selector(didEnterBackground:)
            name:UIApplicationDidEnterBackgroundNotification object:nil];
        [center addObserver:self selector:@selector(audioInterrupted:)
            name:AVAudioSessionInterruptionNotification object:nil];
        [center addObserver:self selector:@selector(audioReset:)
            name:AVAudioSessionMediaServicesWereResetNotification object:nil];
        if ([[NSUserDefaults standardUserDefaults] boolForKey:PreferenceKey]) {
            [self setEnabled:YES];
        }
    }
    return self;
}

#pragma mark - Silent sound

- (BOOL)startSilence {
    if (_silence.isPlaying) { _soundStatus = @"playing"; return YES; }
    AVAudioSession *session = [AVAudioSession sharedInstance];
    NSError *error = nil;
    // Mixed with other audio, so music or a video elsewhere keeps playing.
    BOOL ready = [session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault
                              options:AVAudioSessionCategoryOptionMixWithOthers error:&error]
        && [session setActive:YES error:&error];
    if (ready && !_silence) {
        _silence = [[AVAudioPlayer alloc] initWithData:SilentWave() error:&error];
        _silence.numberOfLoops = -1;
    }
    if (ready && _silence && [_silence play]) {
        _soundStatus = @"playing";
        return YES;
    }
    _soundStatus = [@"not playing: " stringByAppendingString:ErrorText(error)];
    NSLog(@"[background] Silent sound did not start (%@)", ErrorText(error));
    return NO;
}

- (void)stopSilence {
    if (!_silence) return;
    [_silence stop];
    _silence = nil;
    _soundStatus = @"off";
    AVAudioSession *session = [AVAudioSession sharedInstance];
    // Fails harmlessly while the page is playing a voice message itself.
    [session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    [session setCategory:AVAudioSessionCategorySoloAmbient error:nil];
}

// Plays the sound again if something stopped it; counted, for the details.
- (void)resumeSilence {
    if (!_on || _silence.isPlaying) return;
    if ([self startSilence]) _restarts += 1;
}

- (void)audioInterrupted:(NSNotification *)notification {
    NSUInteger type = [notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self->_on) return;
        if (type == AVAudioSessionInterruptionTypeBegan) {
            self->_interruptions += 1;
            self->_soundStatus = @"interrupted";
        } else {
            // A phone call or Siri stopped the sound; once over, play it again.
            [self resumeSilence];
        }
    });
}

- (void)audioReset:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self->_on) return;
        // The old player belongs to the audio service that went away.
        self->_silence = nil;
        [self resumeSilence];
    });
}

#pragma mark - TrollStore extra

- (NSDictionary<NSString *, NSString *> *)preferenceSelectors {
    return @{
        @"_pageVisibilityBasedProcessSuppressionEnabled": @"_setPageVisibilityBasedProcessSuppressionEnabled:",
        @"_hiddenPageDOMTimerThrottlingEnabled": @"_setHiddenPageDOMTimerThrottlingEnabled:",
        @"_hiddenPageDOMTimerThrottlingAutoIncreases": @"_setHiddenPageDOMTimerThrottlingAutoIncreases:"
    };
}

- (NSString *)extraSupportFailure:(NSString **)detail {
    NSString *entitlementFailure = EntitlementFailure(detail);
    if (entitlementFailure.length) return entitlementFailure;
    if (!_webView) { *detail = @"WKWebView unavailable"; return @"webview"; }
    Class assertionClass = NSClassFromString(@"RBSAssertion");
    for (NSString *name in @[@"RBSTarget", @"RBSDomainAttribute", @"RBSAssertion"]) {
        if (!NSClassFromString(name)) { *detail = name; return @"runningboard-api"; }
    }
    if (![NSClassFromString(@"RBSTarget") respondsToSelector:@selector(targetWithPid:)]) {
        *detail = @"RBSTarget targetWithPid:"; return @"runningboard-api";
    }
    if (![NSClassFromString(@"RBSDomainAttribute") respondsToSelector:@selector(attributeWithDomain:name:)]) {
        *detail = @"RBSDomainAttribute attributeWithDomain:name:"; return @"runningboard-api";
    }
    for (NSString *name in @[@"initWithExplanation:target:attributes:", @"acquireWithError:",
                            @"addObserver:", @"removeObserver:", @"invalidate"]) {
        if (![assertionClass instancesRespondToSelector:NSSelectorFromString(name)]) {
            *detail = [@"RBSAssertion " stringByAppendingString:name]; return @"runningboard-api";
        }
    }
    WKPreferences *preferences = _webView.configuration.preferences;
    NSDictionary *selectors = [self preferenceSelectors];
    for (NSString *key in selectors) {
        for (NSString *selector in @[key, selectors[key]]) {
            if (![preferences respondsToSelector:NSSelectorFromString(selector)]) {
                *detail = [@"WKPreferences " stringByAppendingString:selector]; return @"webkit-api";
            }
        }
    }
    return @"";
}

- (id)holdProcess:(pid_t)pid name:(NSString *)name error:(NSError **)error {
    id target = [NSClassFromString(@"RBSTarget") targetWithPid:pid];
    id attribute = [NSClassFromString(@"RBSDomainAttribute")
        attributeWithDomain:@"com.apple.webkit" name:@"Foreground"];
    if (!target || !attribute) return nil;
    id assertion = [[NSClassFromString(@"RBSAssertion") alloc]
        initWithExplanation:[@"Grindflop background " stringByAppendingString:name]
                     target:target attributes:@[attribute]];
    return [assertion acquireWithError:error] ? assertion : nil;
}

- (void)acquireExtras {
    if (_assertion) return;
    NSString *detail = @"";
    NSString *failure = [self extraSupportFailure:&detail];
    if (failure.length) {
        // An ordinary sideloaded build ends here, which is fine.
        _extraStatus = [NSString stringWithFormat:@"unavailable (%@: %@)", failure, detail];
        return;
    }
    @try {
        NSError *error = nil;
        id candidate = [self holdProcess:getpid() name:@"app" error:&error];
        if (!candidate) {
            _extraStatus = [@"denied " stringByAppendingString:ErrorText(error)];
            return;
        }
        _assertion = candidate;
        _observer = [FGAssertionObserver new];
        __weak FGBackgroundRuntime *weakSelf = self;
        _observer.invalidated = ^(id invalidated) {
            [weakSelf assertion:invalidated didInvalidateWithError:nil];
        };
        [candidate addObserver:_observer];
        WKPreferences *preferences = _webView.configuration.preferences;
        NSMutableDictionary *saved = [NSMutableDictionary dictionary];
        NSDictionary *selectors = [self preferenceSelectors];
        for (NSString *key in selectors) saved[key] = @(ReadPreference(preferences, key));
        // Store before applying, so a partial failure can be rolled back.
        _savedPreferences = saved;
        if (@available(iOS 17.0, *)) {
            _savedSchedulingPolicy = @(preferences.inactiveSchedulingPolicy);
            preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
        }
        for (NSString *key in saved) WritePreference(preferences, selectors[key], NO);
        _extraStatus = @"held";
        [self refreshHelpers];
    } @catch (NSException *exception) {
        [self releaseExtras];
        _extraStatus = [@"failed " stringByAppendingString:exception.name];
    }
}

- (void)restorePreferences {
    WKPreferences *preferences = _webView.configuration.preferences;
    if (@available(iOS 17.0, *)) {
        if (_savedSchedulingPolicy) preferences.inactiveSchedulingPolicy = (WKInactiveSchedulingPolicy)_savedSchedulingPolicy.integerValue;
    }
    _savedSchedulingPolicy = nil;
    for (NSString *key in _savedPreferences) {
        @try { WritePreference(preferences, [self preferenceSelectors][key], [_savedPreferences[key] boolValue]); }
        @catch (NSException *exception) { NSLog(@"[background] Could not restore WebKit preference %@", key); }
    }
    _savedPreferences = nil;
}

- (void)releaseExtras {
    id previous = _assertion;
    _assertion = nil; // Ignore an already queued invalidation callback for this assertion.
    [previous removeObserver:_observer];
    _observer = nil;
    [previous invalidate];
    for (id helper in _helpers.allValues) [helper invalidate];
    [_helpers removeAllObjects];
    [_helperPids removeAllObjects];
    [_helperStatus removeAllObjects];
    [self restorePreferences];
    _extraStatus = @"off";
}

- (NSDictionary<NSString *, NSNumber *> *)helperProcesses {
    WKWebView *webView = _webView;
    pid_t page = ProcessIdentifier(webView, @"_webProcessIdentifier");
    pid_t storage = ProcessIdentifier(webView, @"_networkProcessIdentifier");
    if (!storage) storage = ProcessIdentifier(webView.configuration.websiteDataStore, @"_networkProcessIdentifier");
    if (!storage) storage = ProcessIdentifier(webView.configuration.processPool, @"_networkProcessIdentifier");
    return @{ @"page": @(page), @"storage": @(storage) };
}

// Holds each WebKit process, again whenever WebKit has replaced one.
- (void)refreshHelpers {
    if (!_assertion) return;
    NSDictionary<NSString *, NSNumber *> *processes = [self helperProcesses];
    for (NSString *name in processes) {
        pid_t pid = processes[name].intValue;
        if (_helpers[name] && _helperPids[name].intValue == pid) continue;
        [_helpers[name] invalidate];
        [_helpers removeObjectForKey:name];
        _helperPids[name] = @(pid);
        if (pid <= 0) { _helperStatus[name] = @"no process"; continue; }
        NSError *error = nil;
        id helper = nil;
        @try {
            helper = [self holdProcess:pid name:name error:&error];
        } @catch (NSException *exception) {
            error = [NSError errorWithDomain:exception.name code:0 userInfo:nil];
        }
        if (helper) {
            _helpers[name] = helper;
            _helperStatus[name] = @"held";
        } else {
            _helperStatus[name] = [@"denied " stringByAppendingString:ErrorText(error)];
            NSLog(@"[background] Could not hold the %@ process (%@)", name, ErrorText(error));
        }
    }
}

- (void)assertion:(id)assertion didInvalidateWithError:(NSError *)error {
    __weak FGBackgroundRuntime *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        FGBackgroundRuntime *self = weakSelf;
        if (!self || self->_assertion != assertion) return;
        // The extra is gone; the sound goes on keeping the app running.
        [self releaseExtras];
        self->_extraStatus = @"revoked";
        [self report];
    });
}

#pragma mark - Switch

- (void)setEnabled:(BOOL)enabled {
    NSAssert([NSThread isMainThread], @"Background runtime requires the main thread");
    _failure = @"";
    _detail = @"";
    if (!enabled) {
        _on = NO;
        [[NSUserDefaults standardUserDefaults] setBool:NO forKey:PreferenceKey];
        [self releaseExtras];
        [self stopSilence];
        [self report];
        return;
    }
    if (!_on) {
        if ([self startSilence]) {
            _on = YES;
            _interruptions = 0;
            _restarts = 0;
            [self acquireExtras];
        } else {
            _failure = @"sound";
            _detail = _soundStatus;
            [self stopSilence];
        }
    }
    // A saved ON value is never treated as proof that the sound started.
    [[NSUserDefaults standardUserDefaults] setBool:_on forKey:PreferenceKey];
    [self report];
}

// What each part is doing, shown under Diagnostic details while enabled.
- (NSString *)keeperDetail {
    NSMutableArray *parts = [NSMutableArray arrayWithObjects:
        [@"sound: " stringByAppendingString:_soundStatus],
        [NSString stringWithFormat:@"sound stopped %lu× / restarted %lu×",
            (unsigned long)_interruptions, (unsigned long)_restarts],
        [@"trollstore: " stringByAppendingString:_extraStatus], nil];
    for (NSString *name in @[@"page", @"storage"]) {
        NSString *status = _helperStatus[name];
        if (status) [parts addObject:[NSString stringWithFormat:@"%@: %@", name, status]];
    }
    return [parts componentsJoinedByString:@" · "];
}

- (void)report {
    NSString *detail = _failure.length ? _detail : _on ? [self keeperDetail] : @"";
    NSDictionary *state = FGBackgroundState(_webView != nil, _on, _failure, detail,
        UIDevice.currentDevice.systemVersion);
    NSData *json = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    NSString *payload = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [_webView evaluateJavaScript:[NSString stringWithFormat:
        @"window.__FG_BACKGROUND__=%@;window.dispatchEvent(new CustomEvent('fg:background',{detail:window.__FG_BACKGROUND__}));", payload]
        completionHandler:nil];
}

- (void)didBecomeActive:(NSNotification *)notification {
    if (_on) {
        [self resumeSilence];
        [self refreshHelpers];
    }
    [self report];
}

// The moment that matters: the sound must be playing, and WebKit may have
// replaced a process since the switch was turned on.
- (void)didEnterBackground:(NSNotification *)notification {
    if (!_on) return;
    [self resumeSilence];
    [self refreshHelpers];
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    [_assertion removeObserver:_observer];
    [_assertion invalidate];
    for (id helper in _helpers.allValues) [helper invalidate];
    [_silence stop];
    [self restorePreferences];
}
@end
