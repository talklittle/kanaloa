%% @author Stephen Schwink <kanaloa@schwink.net>
%% @copyright 2010 Stephen Schwink.

%% @doc Callbacks for the kanaloa_mochiweb application.

-module(kanaloa_mochiweb_app).
-author('Stephen Schwink <kanaloa@schwink.net>').

-behaviour(application).
-export([start/2, stop/1]).


%% @spec start(_Type, _StartArgs) -> ServerRet
%% @doc application start callback for kanaloa_mochiweb.
start(_Type, _StartArgs) ->
    kanaloa_mochiweb_deps:ensure(),
    kanaloa_mochiweb_sup:start_link().

%% @spec stop(_State) -> ServerRet
%% @doc application stop callback for kanaloa_mochiweb.
stop(_State) ->
    ok.


%%
%% Tests
%%
-include_lib("eunit/include/eunit.hrl").
-ifdef(TEST).
-endif.
