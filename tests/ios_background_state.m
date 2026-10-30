#import "../src-tauri/ios-keyboard-fix/ios/BackgroundRuntime/FGBackgroundState.h"
#include <stdio.h>

int main(void) {
    @autoreleasepool {
        NSArray *reports = @[
            FGBackgroundState(YES, NO, @"", @"", @"17.0"),
            FGBackgroundState(YES, YES, @"", @"", @"17.0"),
            FGBackgroundState(NO, NO, @"entitlement-missing", @"permission absent", @"17.0"),
            FGBackgroundState(YES, NO, @"denied", @"RunningBoard (1)", @"17.0"),
        ];
        // Reproduce the old report expressions as a negative control.
        NSString *supportFailure = @"";
        NSObject *assertion = nil;
        NSDictionary *legacy = @{
            @"supported": @(supportFailure.length == 0),
            @"enabled": @(assertion != nil),
            @"failure": @"",
        };
        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"reports": reports, @"legacy": legacy}
                                                      options:0 error:&error];
        if (!json || error) return 1;
        puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
