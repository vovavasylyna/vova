require 'kramdown'
require 'fileutils'
require 'date'
require 'rss'
require 'find'
require 'yaml'

# Load configuration
config = YAML.load_file('_config.yml')

site_url = config['site_url']
site_name = config['site_name']
author_name = config['author_name']

posts_dir = config['directories']['posts']
pages_dir = config['directories']['pages']
public_dir = config['directories']['public']
output_dir = config['directories']['output']
posts_output_dir = config['directories']['posts_output']
pages_output_dir = config['directories']['pages_output']

header_file = config['files']['header']
footer_file = config['files']['footer']
root_index_file = config['files']['root_index']
posts_index_file = config['files']['posts_index']
rss_file = config['files']['rss']

post_count = config['misc']['post_count']

# Make sure output directories exist
[posts_output_dir, pages_output_dir].each { |dir| FileUtils.mkdir_p(dir) }

# Read the footer content
footer_content = File.read(footer_file)

# Replace the title meta tag in the header.html
def replace_title_placeholder(header_content, title)
  header_content.gsub('<title>{{TITLE}}</title>', "<title>#{title}</title>")
end

# Grab the title from each markdown file
def extract_title_from_md(lines)
  first_line = lines.first
  first_line&.start_with?('# ') ? first_line[2..-1].strip : 'Blog Index'
end

# Convert markdown files
def process_markdown_files(input_directory, output_directory, header_content, footer_content)
  items = []

  Find.find(input_directory) do |path|
    next unless path =~ /\.md\z/

    md_content = File.read(path)
    lines = md_content.lines

    title = extract_title_from_md(lines)
    date = Date.parse(lines[2]&.strip || '') rescue Date.today
    html_content = Kramdown::Document.new(md_content).to_html

    relative_path = path.sub(input_directory + '/', '').sub('.md', '')
    item_dir = File.join(output_directory, relative_path)
    output_file = "#{item_dir}/index.html"
    FileUtils.mkdir_p(item_dir)

    header = replace_title_placeholder(header_content, title)
    File.write(output_file, header + html_content + footer_content)

    items << { title: title, date: date, link: relative_path + '/', content: html_content }
  end

  items
end

# Create the root index file
def generate_index(posts, header_content, footer_content, root_index_file, post_count, output_dir, posts_dir)
  root_index_content = File.read(root_index_file)
  root_title = extract_title_from_md(root_index_content.lines)
  root_html = Kramdown::Document.new(root_index_content).to_html

  header = replace_title_placeholder(header_content, root_title)

  index_content = header + root_html + "<ul class=\"posts\">\n"
  posts.first(post_count).each { |post| index_content << "<li><span>#{post[:date]}</span><a href='/#{posts_dir}/#{post[:link]}'>#{post[:title]}</a></li>\n" }
  index_content << footer_content

  File.write("#{output_dir}/index.html", index_content)
end

# Create the full posts list page
def generate_full_posts_list(posts, header_content, footer_content, posts_index_file, output_dir, posts_dir)
  posts_index_content = File.read(posts_index_file)
  posts_title = extract_title_from_md(posts_index_content.lines)
  posts_html = Kramdown::Document.new(posts_index_content).to_html

  header = replace_title_placeholder(header_content, posts_title)

  list_content = header + posts_html + "<ul class=\"posts\">\n"
  posts.each { |post| list_content << "<li><span>#{post[:date]}</span><a href='/#{posts_dir}/#{post[:link]}'>#{post[:title]}</a></li>\n" }
  list_content << "</ul>\n" + footer_content

  File.write("#{output_dir}/posts/index.html", list_content)
end

# Generate the RSS 2.0 feed
def generate_rss(posts, rss_file, author_name, site_name, site_url, posts_dir)
  rss = RSS::Maker.make("2.0") do |maker|
    maker.channel.author = author_name
    maker.channel.updated = Time.now.to_s
    maker.channel.title = "#{site_name} RSS Feed"
    maker.channel.description = "The official RSS Feed for #{site_url}"
    maker.channel.link = site_url

    posts.each do |post|
      date = Date.parse(post[:date].to_s).to_time + 12*60*60 # Force time to midday
      item_link = "#{site_url}/#{posts_dir}/#{post[:link]}"
      item_title = post[:title]
      item_content = post[:content]

      maker.items.new_item do |item|
        item.link = item_link
        item.title = item_title
        item.updated = date.to_s
        item.pubDate = date.rfc822
        item.description = item_content
      end
    end
  end

  File.write(rss_file, rss)
end

# Process header, posts, pages, etc.
header_content = File.read(header_file)

posts = process_markdown_files(posts_dir, posts_output_dir, header_content, footer_content).sort_by { |post| -post[:date].to_time.to_i }
pages = process_markdown_files(pages_dir, pages_output_dir, header_content, footer_content)

generate_index(posts, header_content, footer_content, root_index_file, post_count, output_dir, posts_dir)
generate_full_posts_list(posts, header_content, footer_content, posts_index_file, output_dir, posts_dir)
FileUtils.cp_r(public_dir, output_dir)
generate_rss(posts, rss_file, author_name, site_name, site_url, posts_dir)

puts "Blog built successfully in '#{output_dir}' folder. Have a great day!"
