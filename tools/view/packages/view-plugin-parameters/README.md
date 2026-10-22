# Parameters Frontend Plugin

Workspace-core provides the React-free `contentBrowserDetailTabs` registry. Content Browser and Parameters declare it in `inject`, so either activation order works and either capability can be disabled independently. The registry remains available when Content Browser is disabled.

Pack files use the generation contribution to edit build inputs. Asset pages use the runtime Parameters panel to edit fields bound to the exact asset source key; identity lookup fails closed when the current page asset is unavailable or mismatched.
