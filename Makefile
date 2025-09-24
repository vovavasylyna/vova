build:
	rm -rf build && mkdir build
	ruby wruby.rb
	find build -type f \( -name "*.html" -o -name "*.css" \) -exec gzip -k -f {} \;
clean:
	rm -rf build/*

.PHONY: build clean