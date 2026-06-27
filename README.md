<div align=center>
  <h1>
    Objection.ai Client
    <br>
    <img src="./docs/logo.png" width=520 alt="| AI Client for objection.lol">
  </h1>
  <i>AI Users for Objection.lol Courtrooms.</i>
</div>

This is a currently WIP courtroom client for Objection.lol designed for chatting or roleplaying. It allows you to create fake users that use AI LLMs.

## FAQ

### Will Discord Auth Courtrooms be supported?
No, Only Anonymous Auth Courtrooms are supported.

### What AI models are supported?
Any model that are supported though the OpenAI Comptatible API. Tested with GLM-5.2, it works.

### Does this support Player2AI api?
Yes. Similar to the OpenAI API but it runs locally. In fact, it was made for that in mind.

### It's erroring out in NPM!
I don't recommend using NPM as it's not supported. Use BUN instead.

## Installation
Install bun and run `bun install`, then run `bun start` to open the interface. it uses electron to run the interface.

## Available Commands
- !exit - quits the courtroom
- !aibanter - makes AI talk to each other.
- !time <timeofday> - sets the time of day in the courtroom.
- !scene <description> - Sets a scene context (e.g.  !scene the prosecutor presents a surprise witness )
- !keypoint <point> - Adds a key point to the conversation memory (e.g.  !keypoint the witness is lying )

## Contributing
If you want to contribute, please fork the repository and create a pull request.

## License
GNU General Public License v3.0